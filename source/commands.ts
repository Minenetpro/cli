import {spawn} from 'node:child_process';
import {arch, hostname, platform} from 'node:os';
import {daemonRequest} from './daemon.js';
import type {CliFlags, CommandResult, ProgressUpdate} from './types.js';

type ExecuteInput = {
	command: string;
	args: string[];
	flags: CliFlags;
	cwd: string;
	version: string;
	onProgress?: (update: ProgressUpdate) => void;
};

type StatusResponse = {
	authenticated: boolean;
	profile: {
		team_id: string;
		team_slug: string;
		team_name: string;
		token_name: string;
		created_at: number;
		api_base_url: string;
	} | null;
};

type WorkspacePushResponse = {
	ok: boolean;
	workspaceRoot: string;
	updated: string[];
	skipped: string[];
	created?: string[];
	deleted?: string[];
	conflicts?: Array<{
		configurationName: string;
		directoryName: string;
		reason?: string;
	}>;
	failed?: Array<{
		configurationId?: string;
		directoryName: string;
		operation: 'create' | 'update' | 'delete';
		reason: string;
		code?: string;
		validationIssues?: Array<{
			path?: string;
			message: string;
		}>;
	}>;
};

type QueuedRunWithMetadata = {
	configurationId: string;
	runId: string;
	status: string;
	configurationName: string;
	directoryName: string | null;
};

function emit(onProgress: ExecuteInput['onProgress'], log: string) {
	onProgress?.({log});
}

function emitPhase(onProgress: ExecuteInput['onProgress'], phase: string) {
	onProgress?.({phase});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function toWorkspacePushResponse(payload: unknown): WorkspacePushResponse | null {
	if (!isRecord(payload)) {
		return null;
	}

	if (typeof payload['ok'] !== 'boolean') {
		return null;
	}

	if (typeof payload['workspaceRoot'] !== 'string') {
		return null;
	}

	if (!Array.isArray(payload['updated']) || !Array.isArray(payload['skipped'])) {
		return null;
	}

	return payload as WorkspacePushResponse;
}

function formatDaemon409Message(input: ExecuteInput, payload: unknown): string {
	if (input.flags.debug) {
		return `Workspace sync was rejected (409). Raw payload: ${JSON.stringify(payload)}`;
	}

	return 'Workspace sync was rejected (409). Re-run with --debug for raw payload.';
}

function describeConflictReason(reason: string | undefined): string {
	if (reason === 'local_and_remote_changed') {
		return 'Both local and remote changed since your last pull.';
	}

	return reason ? `Conflict: ${reason}.` : 'Workspace conflict detected.';
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolvePromise => {
		setTimeout(resolvePromise, ms);
	});
}

function openBrowser(url: string): Promise<boolean> {
	return new Promise(resolvePromise => {
		let child;

		if (process.platform === 'darwin') {
			child = spawn('open', [url], {stdio: 'ignore'});
		} else if (process.platform === 'win32') {
			child = spawn('cmd', ['/c', 'start', '', url], {stdio: 'ignore'});
		} else {
			child = spawn('xdg-open', [url], {stdio: 'ignore'});
		}

		child.on('error', () => resolvePromise(false));
		child.on('close', code => resolvePromise(code === 0));
	});
}

async function requireAuth(onProgress: ExecuteInput['onProgress']) {
	const status = await daemonRequest<StatusResponse>({
		path: '/v1/auth/status',
		method: 'GET',
	});

	if (!status.authenticated || !status.profile) {
		emit(onProgress, 'Not logged in. Run `minenet login` first.');
		return null;
	}

	return status.profile;
}

async function requestWorkspacePush(
	input: ExecuteInput,
): Promise<WorkspacePushResponse> {
	return daemonRequest<WorkspacePushResponse>({
		path: '/v1/workspace/push',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			selector: input.flags.config,
			force: input.flags.force,
		},
	});
}

async function requestWorkspacePushHandled(
	input: ExecuteInput,
): Promise<WorkspacePushResponse> {
	try {
		return await requestWorkspacePush(input);
	} catch (error) {
		const daemonError = error as Error & {status?: number; payload?: unknown};
		if (daemonError.status === 409) {
			const parsed = toWorkspacePushResponse(daemonError.payload);
			if (parsed) {
				return parsed;
			}

			throw new Error(formatDaemon409Message(input, daemonError.payload));
		}

		throw error;
	}
}

function emitPushIssues(
	onProgress: ExecuteInput['onProgress'],
	result: WorkspacePushResponse,
	debug: boolean,
) {
	for (const conflict of result.conflicts ?? []) {
		emit(
			onProgress,
			`- ${conflict.configurationName} (${conflict.directoryName}): ${describeConflictReason(
				conflict.reason,
			)}${debug && conflict.reason ? ` [${conflict.reason}]` : ''}`,
		);
	}

	for (const failure of result.failed ?? []) {
		const displayReason =
			failure.validationIssues && failure.validationIssues.length > 0
				? 'Configuration validation failed'
				: failure.reason;
		const ref =
			debug && failure.configurationId
				? `${failure.directoryName} (${failure.configurationId})`
				: failure.directoryName;
		emit(
			onProgress,
			`- ${failure.operation} ${ref}: ${displayReason}${
				debug && failure.code ? ` [${failure.code}]` : ''
			}`,
		);

		for (const issue of failure.validationIssues ?? []) {
			const pathPrefix = issue.path ? `${issue.path}: ` : '';
			emit(onProgress, `  · ${pathPrefix}${issue.message}`);
		}
	}
}

function emitPushSummary(
	onProgress: ExecuteInput['onProgress'],
	result: WorkspacePushResponse,
) {
	const createdCount = result.created?.length ?? 0;
	const deletedCount = result.deleted?.length ?? 0;
	emit(
		onProgress,
		`Pushed ${result.updated.length} updated, ${createdCount} created, ${deletedCount} deleted (${result.skipped.length} skipped)`,
	);
}

function emitSyncGuidance(
	input: ExecuteInput,
	result: WorkspacePushResponse,
	command: 'push' | 'deploy',
) {
	if ((result.conflicts?.length ?? 0) === 0 && (result.failed?.length ?? 0) === 0) {
		return;
	}

	const selectedConfig = input.flags.config?.trim();
	const preferredSelector =
		selectedConfig || result.conflicts?.[0]?.directoryName || '<config>';
	const retrySuffix = selectedConfig ? ` --config ${selectedConfig}` : '';
	const retryCommand =
		command === 'deploy'
			? `minenet deploy${retrySuffix}`
			: `minenet push${retrySuffix}`;

	emit(
		input.onProgress,
		`Resolve sync issues before retrying ${command}:`,
	);
	emit(
		input.onProgress,
		`1) Pull latest: minenet pull --config ${preferredSelector}`,
	);
	emit(input.onProgress, '2) Review and merge local config.yml changes');
	emit(input.onProgress, `3) Retry: ${retryCommand}`);
	emit(
		input.onProgress,
		'Use --force only if you intentionally want local changes to overwrite remote.',
	);
}

function formatQueuedRunLabel(
	run: QueuedRunWithMetadata,
	debug: boolean,
): string {
	const hasFriendlyName = run.configurationName !== run.configurationId;
	const baseName = hasFriendlyName
		? run.configurationName
		: run.directoryName || 'configuration';
	if (!debug) {
		return baseName;
	}

	return `${baseName} [${run.configurationId}]`;
}

async function runLogin(input: ExecuteInput): Promise<CommandResult> {
	const start = await daemonRequest<{
		ok: boolean;
		api_base_url: string;
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete: string;
		expires_in: number;
		interval: number;
	}>({
		path: '/v1/auth/login/start',
		method: 'POST',
		body: {
			apiBaseUrl: input.flags.api,
			deviceName: 'minenet-cli',
			os: platform(),
			arch: arch(),
			hostname: hostname(),
			cliVersion: input.version,
		},
	});

	emit(
		input.onProgress,
		`Open this link to approve login:\n${start.verification_uri_complete}`,
	);
	emit(input.onProgress, `User code: ${start.user_code}`);

	if (!input.flags.noOpen) {
		const opened = await openBrowser(start.verification_uri_complete);
		emit(
			input.onProgress,
			opened
				? 'Browser opened. Complete approval there.'
				: 'Could not auto-open browser. Open the link manually.',
		);
	}

	const startedAt = Date.now();
	let intervalSec = start.interval;

	while (Date.now() - startedAt < start.expires_in * 1000) {
		await sleep(intervalSec * 1000);

		const poll = await daemonRequest<
			| {ok: true; authenticated: true; profile: StatusResponse['profile']}
			| {
					ok: false;
					authenticated: false;
					error: string;
					error_description?: string;
					interval?: number;
			  }
		>({
			path: '/v1/auth/login/poll',
			method: 'POST',
			body: {
				apiBaseUrl: start.api_base_url,
				deviceCode: start.device_code,
			},
		});

		if (poll.ok && poll.authenticated) {
			emit(
				input.onProgress,
				`Authenticated for team ${
					poll.profile?.team_slug ?? poll.profile?.team_id
				}`,
			);
			return {
				ok: true,
				exitCode: 0,
				logs: [],
				payload: poll,
			};
		}

		if (!poll.ok && poll.error === 'slow_down') {
			intervalSec = Math.max(intervalSec + 2, poll.interval ?? intervalSec + 2);
			emit(
				input.onProgress,
				`Polling slowed down. Next check in ${intervalSec}s.`,
			);
			continue;
		}

		if (!poll.ok && poll.error === 'authorization_pending') {
			emit(input.onProgress, 'Waiting for approval...');
			continue;
		}

		if (!poll.ok && poll.error === 'expired_token') {
			emit(
				input.onProgress,
				'Login request expired. Run `minenet login` again.',
			);
			return {
				ok: false,
				exitCode: 3,
				logs: [],
				payload: poll,
			};
		}

		emit(
			input.onProgress,
			`Login failed: ${
				!poll.ok ? poll.error_description || poll.error : 'Unknown error'
			}`,
		);
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: poll,
		};
	}

	emit(input.onProgress, 'Login timeout reached.');
	return {
		ok: false,
		exitCode: 3,
		logs: [],
	};
}

async function runWhoami(input: ExecuteInput): Promise<CommandResult> {
	const status = await daemonRequest<StatusResponse>({
		path: '/v1/auth/status',
		method: 'GET',
	});

	if (!status.authenticated || !status.profile) {
		emit(input.onProgress, 'Not logged in');
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: status,
		};
	}

	emit(
		input.onProgress,
		`Current team: ${status.profile.team_name} (${status.profile.team_slug})`,
	);

	return {
		ok: true,
		exitCode: 0,
		logs: [],
		payload: status,
	};
}

async function runLogout(input: ExecuteInput): Promise<CommandResult> {
	const response = await daemonRequest<{ok: boolean}>({
		path: '/v1/auth/logout',
		method: 'POST',
		body: {},
	});

	if (response.ok) {
		emit(input.onProgress, 'Logged out.');
	}

	return {
		ok: response.ok,
		exitCode: response.ok ? 0 : 1,
		logs: [],
		payload: response,
	};
}

async function runPull(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input.onProgress);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	const result = await daemonRequest<{
		ok: boolean;
		workspaceRoot: string;
		pulled?: number;
		count?: number;
		conflicts?: Array<{configurationName: string; directoryName: string}>;
	}>({
		path: '/v1/workspace/pull',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			force: input.flags.force,
		},
	});

	if (!result.ok) {
		emit(input.onProgress, 'Pull blocked by conflicts.');
		for (const conflict of result.conflicts ?? []) {
			emit(
				input.onProgress,
				`- ${conflict.configurationName} (${conflict.directoryName})`,
			);
		}
		return {ok: false, exitCode: 4, logs: [], payload: result};
	}

	emit(
		input.onProgress,
		`Pulled ${result.pulled ?? 0}/${result.count ?? 0} configurations into ${
			result.workspaceRoot
		}`,
	);

	return {ok: true, exitCode: 0, logs: [], payload: result};
}

async function runPush(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input.onProgress);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	const result = await requestWorkspacePushHandled(input);

	if (!result.ok) {
		emit(input.onProgress, 'Push completed with issues.');
		emitPushIssues(input.onProgress, result, input.flags.debug);
		emitSyncGuidance(input, result, 'push');
		return {ok: false, exitCode: 4, logs: [], payload: result};
	}

	emitPushSummary(input.onProgress, result);

	return {ok: true, exitCode: 0, logs: [], payload: result};
}

async function runDeploy(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input.onProgress);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	emitPhase(input.onProgress, 'sync');
	emit(input.onProgress, 'Syncing workspace before deploy...');
	const pushResult = await requestWorkspacePushHandled(input);
	if (!pushResult.ok) {
		emit(input.onProgress, 'Deploy blocked because workspace sync failed.');
		emitPushIssues(input.onProgress, pushResult, input.flags.debug);
		emitSyncGuidance(input, pushResult, 'deploy');
		emitPhase(input.onProgress, 'blocked');
		return {ok: false, exitCode: 4, logs: [], payload: pushResult};
	}

	emitPushSummary(input.onProgress, pushResult);
	emitPhase(input.onProgress, 'queue');

	const status = await daemonRequest<{
		workspaceRoot: string;
		hasManifest: boolean;
		manifest: {
			entries: Record<
				string,
				{directoryName: string; configurationName: string}
			>;
		} | null;
	}>({
		path: '/v1/workspace/status',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
		},
	});

	const manifestEntries = status.manifest?.entries ?? {};

	const queued = await daemonRequest<{
		workspaceRoot: string;
		queued: Array<{configurationId: string; runId: string; status: string}>;
	}>({
		path: '/v1/workspace/deploy',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			selector: input.flags.config,
		},
	});

	const queuedWithNames: QueuedRunWithMetadata[] = queued.queued.map(run => {
		const manifestEntry = manifestEntries[run.configurationId];
		return {
			...run,
			configurationName:
				manifestEntry?.configurationName ?? run.configurationId,
			directoryName: manifestEntry?.directoryName ?? null,
		};
	});

	for (const [index, run] of queuedWithNames.entries()) {
		const nameLabel = formatQueuedRunLabel(run, input.flags.debug);
		const directorySuffix =
			run.directoryName && run.directoryName !== nameLabel
				? ` · ${run.directoryName}`
				: '';
		const debugSuffix = input.flags.debug ? ` -> run ${run.runId}` : '';
		emit(
			input.onProgress,
			`Queued #${index + 1} ${nameLabel}${directorySuffix}${debugSuffix}`,
		);
	}

	if (input.flags.detach) {
		emitPhase(input.onProgress, 'detached');
		return {
			ok: true,
			exitCode: 0,
			logs: [],
			payload: {
				workspaceRoot: queued.workspaceRoot,
				queued: queuedWithNames,
			},
		};
	}

	emitPhase(input.onProgress, 'monitor');
	let allOk = true;

	for (const [index, run] of queuedWithNames.entries()) {
		let lastPhase = '';
		const nameLabel = formatQueuedRunLabel(run, input.flags.debug);
		const runLabel = `#${index + 1} ${nameLabel}`;
		const debugRunId = input.flags.debug ? ` run=${run.runId}` : '';

		while (true) {
			const details = await daemonRequest<{
				run: {
					status:
						| 'queued'
						| 'planning'
						| 'executing'
						| 'finalizing'
						| 'succeeded'
						| 'failed'
						| 'canceled'
						| 'running'
						| 'completed';
					stage?: 'planning' | 'executing' | 'finalizing' | null;
					summary: {
						succeeded?: number;
						success?: number;
						failed?: number;
					} | null;
					error: string | null;
					failure_class?: string | null;
				};
			}>({
				path: `/v1/deploy/runs/${encodeURIComponent(run.runId)}`,
				method: 'GET',
			});

			const phase = details.run.stage
				? `${details.run.status} (${details.run.stage})`
				: details.run.status;
			if (phase !== lastPhase) {
				lastPhase = phase;
				emit(input.onProgress, `Run ${runLabel}: ${phase}${debugRunId}`);
			}

			if (
				details.run.status === 'succeeded' ||
				details.run.status === 'completed'
			) {
				const summary = details.run.summary;
				emit(
					input.onProgress,
					`Run ${runLabel} ${details.run.status} (succeeded=${
						summary?.succeeded ?? summary?.success ?? 0
					}, failed=${summary?.failed ?? 0})${debugRunId}`,
				);
				break;
			}

			if (
				details.run.status === 'failed' ||
				details.run.status === 'canceled'
			) {
				emit(
					input.onProgress,
					`Run ${runLabel} ${details.run.status}: ${
						details.run.error ?? details.run.failure_class ?? 'Unknown error'
					}${debugRunId}`,
				);
				allOk = false;
				break;
			}

			await sleep(2000);
		}
	}

	emitPhase(input.onProgress, allOk ? 'done' : 'failed');
	return {
		ok: allOk,
		exitCode: allOk ? 0 : 2,
		logs: [],
		payload: {
			workspaceRoot: queued.workspaceRoot,
			queued: queuedWithNames,
		},
	};
}

async function runStatus(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input.onProgress);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	const status = await daemonRequest<{
		workspaceRoot: string;
		hasManifest: boolean;
		manifest: {
			entries: Record<
				string,
				{directoryName: string; configurationName: string}
			>;
		} | null;
	}>({
		path: '/v1/workspace/status',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
		},
	});

	emit(input.onProgress, `Workspace: ${status.workspaceRoot}`);
	emit(
		input.onProgress,
		`Manifest: ${status.hasManifest ? 'present' : 'missing'}`,
	);

	if (status.hasManifest && status.manifest) {
		const entries = Object.values(status.manifest.entries);
		emit(input.onProgress, `Configurations: ${entries.length}`);
		for (const entry of entries.slice(0, 10)) {
			emit(
				input.onProgress,
				`- ${entry.configurationName} -> ${entry.directoryName}`,
			);
		}
	}

	return {
		ok: true,
		exitCode: 0,
		logs: [],
		payload: status,
	};
}

export async function executeCommand(
	input: ExecuteInput,
): Promise<CommandResult> {
	const cmd = input.command;

	if (cmd === 'login') {
		return runLogin(input);
	}

	if (cmd === 'logout') {
		return runLogout(input);
	}

	if (cmd === 'whoami') {
		return runWhoami(input);
	}

	if (cmd === 'pull') {
		return runPull(input);
	}

	if (cmd === 'push') {
		return runPush(input);
	}

	if (cmd === 'deploy') {
		return runDeploy(input);
	}

	if (cmd === 'status') {
		return runStatus(input);
	}

	return {
		ok: false,
		exitCode: 1,
		logs: [`Unknown command: ${cmd}`],
	};
}
