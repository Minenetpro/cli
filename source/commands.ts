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
	pushed?: Array<{
		configurationId: string;
		directoryName: string;
		versionId: string;
		versionNumber: number;
		created: boolean;
		pushMessage?: string | null;
	}>;
	conflicts?: Array<{
		configurationId?: string;
		configurationName: string;
		directoryName: string;
		reason?: string;
	}>;
	failed?: Array<{
		configurationId?: string;
		directoryName: string;
		operation: 'create' | 'update' | 'delete' | 'push';
		reason: string;
		code?: string;
		validationIssues?: Array<{
			path?: string;
			message: string;
		}>;
	}>;
};

type WorkspacePullResponse = {
	ok: boolean;
	workspaceRoot: string;
	pulled?: number;
	count?: number;
	skipped?: number;
	conflicts?: Array<{
		configurationId?: string;
		configurationName: string;
		directoryName: string;
		reason?: string;
	}>;
};

type WorkspaceVersionsResponse = {
	workspaceRoot: string;
	versions: Array<{
		configurationId: string;
		configurationName: string;
		directoryName: string;
		count: number;
		versions: Array<{
			id: string;
			version_number: number;
			spec_hash: string;
			resource_count: number;
			pushed_by: string;
			pushed_at: number;
			push_message?: string | null;
		}>;
	}>;
};

type WorkspaceDiffResponse = {
	workspaceRoot: string;
	configurationId: string;
	configurationName: string;
	directoryName: string;
	ok: boolean;
	from: {
		id: string;
		version_number: number;
	} | null;
	to: {
		id: string;
		version_number: number;
	};
	diff: {
		unified: string;
		truncated: boolean;
		stats: {
			added: number;
			removed: number;
		};
	};
	has_changes: boolean;
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

function daemonRequestForInput<T>(
	input: ExecuteInput,
	request: {
		path: string;
		method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
		body?: unknown;
	},
): Promise<T> {
	return daemonRequest<T>({
		...request,
		apiBaseUrl: input.flags.api,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === 'string');
}

function toPushedVersionEntries(
	value: unknown,
): NonNullable<WorkspacePushResponse['pushed']> {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map(item => {
			if (!isRecord(item)) {
				return null;
			}
			if (
				typeof item['configurationId'] !== 'string' ||
				typeof item['directoryName'] !== 'string' ||
				typeof item['versionId'] !== 'string' ||
				typeof item['versionNumber'] !== 'number' ||
				typeof item['created'] !== 'boolean'
			) {
				return null;
			}
			const pushMessage =
				typeof item['pushMessage'] === 'string' ? item['pushMessage'] : null;

			return {
				configurationId: item['configurationId'],
				directoryName: item['directoryName'],
				versionId: item['versionId'],
				versionNumber: item['versionNumber'],
				created: item['created'],
				pushMessage,
			};
		})
		.filter(
			(
				entry,
			): entry is {
				configurationId: string;
				directoryName: string;
				versionId: string;
				versionNumber: number;
				created: boolean;
				pushMessage: string | null;
			} => entry !== null,
		);
}

function toWorkspacePushResponse(
	payload: unknown,
): WorkspacePushResponse | null {
	if (!isRecord(payload)) {
		return null;
	}

	if (typeof payload['ok'] !== 'boolean') {
		return null;
	}

	if (typeof payload['workspaceRoot'] !== 'string') {
		return null;
	}

	return {
		...(payload as WorkspacePushResponse),
		updated: toStringArray(payload['updated']),
		skipped: toStringArray(payload['skipped']),
		created: toStringArray(payload['created']),
		deleted: toStringArray(payload['deleted']),
		pushed: toPushedVersionEntries(payload['pushed']),
	};
}

function toWorkspacePullResponse(
	payload: unknown,
): WorkspacePullResponse | null {
	if (!isRecord(payload)) {
		return null;
	}

	if (typeof payload['ok'] !== 'boolean') {
		return null;
	}

	if (typeof payload['workspaceRoot'] !== 'string') {
		return null;
	}

	return payload as WorkspacePullResponse;
}

function formatWorkspace409Message(
	input: ExecuteInput,
	command: 'pull' | 'push',
	payload: unknown,
): string {
	const action = command === 'pull' ? 'Workspace pull' : 'Workspace sync';
	if (input.flags.debug) {
		return `${action} was rejected (409). Raw payload: ${JSON.stringify(
			payload,
		)}`;
	}

	return `${action} was rejected (409). Re-run with --debug for raw payload.`;
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

async function requireAuth(input: ExecuteInput) {
	const status = await daemonRequestForInput<StatusResponse>(input, {
		path: '/v1/auth/status',
		method: 'GET',
	});

	if (!status.authenticated || !status.profile) {
		emit(input.onProgress, 'Not logged in. Run `minenet login` first.');
		return null;
	}

	return status.profile;
}

async function requestWorkspacePush(
	input: ExecuteInput,
): Promise<WorkspacePushResponse> {
	const message =
		typeof input.flags.message === 'string' && input.flags.message.trim()
			? input.flags.message.trim()
			: undefined;

	return daemonRequestForInput<WorkspacePushResponse>(input, {
		path: '/v1/workspace/push',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			selector: input.flags.config,
			force: input.flags.force,
			message,
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

			throw new Error(
				formatWorkspace409Message(input, 'push', daemonError.payload),
			);
		}

		throw error;
	}
}

async function requestWorkspacePull(
	input: ExecuteInput,
): Promise<WorkspacePullResponse> {
	return daemonRequestForInput<WorkspacePullResponse>(input, {
		path: '/v1/workspace/pull',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			force: input.flags.force,
		},
	});
}

async function requestWorkspacePullHandled(
	input: ExecuteInput,
): Promise<WorkspacePullResponse> {
	try {
		return await requestWorkspacePull(input);
	} catch (error) {
		const daemonError = error as Error & {status?: number; payload?: unknown};
		if (daemonError.status === 409) {
			const parsed = toWorkspacePullResponse(daemonError.payload);
			if (parsed) {
				return parsed;
			}

			throw new Error(
				formatWorkspace409Message(input, 'pull', daemonError.payload),
			);
		}

		throw error;
	}
}

async function requestWorkspaceVersions(
	input: ExecuteInput,
): Promise<WorkspaceVersionsResponse> {
	return daemonRequestForInput<WorkspaceVersionsResponse>(input, {
		path: '/v1/workspace/versions',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			selector: input.flags.config,
			limit: input.flags.limit,
		},
	});
}

async function requestWorkspaceDiff(
	input: ExecuteInput,
): Promise<WorkspaceDiffResponse> {
	return daemonRequestForInput<WorkspaceDiffResponse>(input, {
		path: '/v1/workspace/diff',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
			selector: input.flags.config,
			from: input.flags.from,
			to: input.flags.to,
		},
	});
}

function emitPushIssues(
	onProgress: ExecuteInput['onProgress'],
	result: WorkspacePushResponse,
	debug: boolean,
) {
	for (const conflict of result.conflicts ?? []) {
		emit(
			onProgress,
			`- ${conflict.configurationName} (${
				conflict.directoryName
			}): ${describeConflictReason(conflict.reason)}${
				debug && conflict.reason ? ` [${conflict.reason}]` : ''
			}`,
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
	const pushedCount = result.pushed?.length ?? 0;
	const createdVersions =
		result.pushed?.filter(entry => entry.created).length ?? 0;
	emit(
		onProgress,
		`Pushed ${result.updated.length} updated, ${createdCount} created, ${deletedCount} deleted (${result.skipped.length} skipped, ${pushedCount} version actions, ${createdVersions} new versions)`,
	);
}

function emitPushVersionSummary(
	onProgress: ExecuteInput['onProgress'],
	result: WorkspacePushResponse,
	debug: boolean,
) {
	for (const entry of result.pushed ?? []) {
		const versionRef = `v${entry.versionNumber}`;
		const idSuffix = debug ? ` (${entry.versionId})` : '';
		const modeLabel = entry.created ? 'created' : 'reused';
		emit(
			onProgress,
			`- push ${entry.directoryName}: ${modeLabel} ${versionRef}${idSuffix}`,
		);
		const pushMessage =
			typeof entry.pushMessage === 'string' ? entry.pushMessage.trim() : '';
		if (pushMessage) {
			const lines = pushMessage.split('\n');
			for (const [index, line] of lines.entries()) {
				const prefix = index === 0 ? '  message: ' : '           ';
				emit(onProgress, `${prefix}${line}`);
			}
		}
	}
}

function emitSyncGuidance(
	input: ExecuteInput,
	result: WorkspacePushResponse,
	command: 'push' | 'deploy',
) {
	if (
		(result.conflicts?.length ?? 0) === 0 &&
		(result.failed?.length ?? 0) === 0
	) {
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

	emit(input.onProgress, `Resolve sync issues before retrying ${command}:`);
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
	const start = await daemonRequestForInput<{
		ok: boolean;
		api_base_url: string;
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete: string;
		expires_in: number;
		interval: number;
	}>(input, {
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

		const poll = await daemonRequestForInput<
			| {ok: true; authenticated: true; profile: StatusResponse['profile']}
			| {
					ok: false;
					authenticated: false;
					error: string;
					error_description?: string;
					interval?: number;
			  }
		>(input, {
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
	const status = await daemonRequestForInput<StatusResponse>(input, {
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
	emit(input.onProgress, `API base: ${status.profile.api_base_url}`);

	return {
		ok: true,
		exitCode: 0,
		logs: [],
		payload: status,
	};
}

async function runLogout(input: ExecuteInput): Promise<CommandResult> {
	const response = await daemonRequestForInput<{ok: boolean}>(input, {
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
	const profile = await requireAuth(input);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	const result = await requestWorkspacePullHandled(input);

	if (!result.ok) {
		emit(input.onProgress, 'Pull blocked by conflicts.');
		for (const conflict of result.conflicts ?? []) {
			const debugSuffix =
				input.flags.debug && conflict.configurationId
					? ` [${conflict.configurationId}]`
					: '';
			emit(
				input.onProgress,
				`- ${conflict.configurationName} (${
					conflict.directoryName
				}): ${describeConflictReason(conflict.reason)}${debugSuffix}${
					input.flags.debug && conflict.reason ? ` [${conflict.reason}]` : ''
				}`,
			);
		}
		emit(
			input.onProgress,
			'Use --force only if you intentionally want remote configs to overwrite local changes.',
		);
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
	const profile = await requireAuth(input);
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
	emitPushVersionSummary(input.onProgress, result, input.flags.debug);

	return {ok: true, exitCode: 0, logs: [], payload: result};
}

async function runDeploy(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	emit(
		input.onProgress,
		'Deploying from latest pushed versions. Use `minenet push` first to publish local changes.',
	);
	emitPhase(input.onProgress, 'queue');

	const status = await daemonRequestForInput<{
		workspaceRoot: string;
		hasManifest: boolean;
		manifest: {
			entries: Record<
				string,
				{directoryName: string; configurationName: string}
			>;
		} | null;
	}>(input, {
		path: '/v1/workspace/status',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
		},
	});

	const manifestEntries = status.manifest?.entries ?? {};

	let queued: {
		workspaceRoot: string;
		queued: Array<{configurationId: string; runId: string; status: string}>;
	};
	try {
		queued = await daemonRequestForInput<{
			workspaceRoot: string;
			queued: Array<{configurationId: string; runId: string; status: string}>;
		}>(input, {
			path: '/v1/workspace/deploy',
			method: 'POST',
			body: {
				cwd: input.cwd,
				workspacePath: input.flags.workspace,
				selector: input.flags.config,
			},
		});
	} catch (error) {
		const daemonError = error as Error & {
			status?: number;
			payload?: unknown;
		};
		const payload = daemonError.payload as
			| {code?: string; error?: string}
			| undefined;
		if (payload?.code === 'NO_PUSHED_VERSION') {
			const selector =
				typeof input.flags.config === 'string' && input.flags.config.trim()
					? ` --config ${input.flags.config.trim()}`
					: '';
			emit(
				input.onProgress,
				`Deploy blocked: ${payload.error ?? daemonError.message}`,
			);
			emit(input.onProgress, `Push a version first: minenet push${selector}`);
			emitPhase(input.onProgress, 'blocked');
			return {ok: false, exitCode: 4, logs: [], payload: daemonError.payload};
		}
		throw error;
	}

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
			const details = await daemonRequestForInput<{
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
			}>(input, {
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
	const profile = await requireAuth(input);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	const status = await daemonRequestForInput<{
		workspaceRoot: string;
		hasManifest: boolean;
		manifest: {
			entries: Record<
				string,
				{directoryName: string; configurationName: string}
			>;
		} | null;
	}>(input, {
		path: '/v1/workspace/status',
		method: 'POST',
		body: {
			cwd: input.cwd,
			workspacePath: input.flags.workspace,
		},
	});

	emit(input.onProgress, `API base: ${profile.api_base_url}`);
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

function formatPushedAt(timestamp: number): string {
	try {
		return new Date(timestamp).toLocaleString();
	} catch {
		return String(timestamp);
	}
}

async function runVersions(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	const result = await requestWorkspaceVersions(input);
	if (result.versions.length === 0) {
		emit(input.onProgress, 'No matching configurations found in workspace.');
		return {ok: true, exitCode: 0, logs: [], payload: result};
	}

	emit(input.onProgress, `Workspace: ${result.workspaceRoot}`);
	for (const group of result.versions) {
		emit(
			input.onProgress,
			`${group.configurationName} (${group.directoryName}) - ${group.count} versions`,
		);
		for (const version of group.versions) {
			const idSuffix = input.flags.debug ? ` [${version.id}]` : '';
			emit(
				input.onProgress,
				`- v${version.version_number}${idSuffix} · ${formatPushedAt(
					version.pushed_at,
				)} · resources=${version.resource_count}`,
			);
			const pushMessage =
				typeof version.push_message === 'string'
					? version.push_message.trim()
					: '';
			if (pushMessage) {
				for (const [index, line] of pushMessage.split('\n').entries()) {
					const prefix = index === 0 ? '  message: ' : '           ';
					emit(input.onProgress, `${prefix}${line}`);
				}
			}
		}
	}

	return {ok: true, exitCode: 0, logs: [], payload: result};
}

async function runDiff(input: ExecuteInput): Promise<CommandResult> {
	const profile = await requireAuth(input);
	if (!profile) {
		return {
			ok: false,
			exitCode: 3,
			logs: [],
			payload: {error: 'Not logged in'},
		};
	}

	if (!input.flags.config?.trim()) {
		emit(
			input.onProgress,
			'`minenet diff` requires --config <configuration-id-or-directory>.',
		);
		return {
			ok: false,
			exitCode: 1,
			logs: [],
			payload: {error: 'Missing --config'},
		};
	}

	const result = await requestWorkspaceDiff(input);
	const fromRef = result.from ? `v${result.from.version_number}` : 'empty';
	const toRef = `v${result.to.version_number}`;
	const fromSuffix =
		result.from && input.flags.debug ? ` [${result.from.id}]` : '';
	const toSuffix = input.flags.debug ? ` [${result.to.id}]` : '';

	emit(
		input.onProgress,
		`${result.configurationName} (${result.directoryName}) diff ${fromRef}${fromSuffix} -> ${toRef}${toSuffix}`,
	);
	emit(
		input.onProgress,
		`Stats: +${result.diff.stats.added} -${result.diff.stats.removed}${
			result.diff.truncated ? ' (truncated)' : ''
		}`,
	);

	if (!result.diff.unified.trim()) {
		emit(input.onProgress, 'No changes.');
	} else {
		for (const line of result.diff.unified.split('\n')) {
			emit(input.onProgress, line);
		}
	}

	return {ok: true, exitCode: 0, logs: [], payload: result};
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

	if (cmd === 'versions') {
		return runVersions(input);
	}

	if (cmd === 'diff') {
		return runDiff(input);
	}

	return {
		ok: false,
		exitCode: 1,
		logs: [`Unknown command: ${cmd}`],
	};
}
