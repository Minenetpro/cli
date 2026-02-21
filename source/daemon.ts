import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

type DaemonInfo = {
	version: 1;
	port: number;
	token: string;
	pid: number;
	startedAt: number;
};

type DaemonLaunchSpec = {
	command: string;
	args: string[];
	cwd?: string;
};

type GitHubReleaseAsset = {
	name: string;
	browser_download_url: string;
};

type GitHubRelease = {
	tag_name: string;
	assets: GitHubReleaseAsset[];
};

const APP_NAME = 'minenet';
const APP_SERVER_REPO =
	'https://api.github.com/repos/Minenetpro/app-server/releases/latest';

function getConfigDir(): string {
	const home = homedir();

	if (process.platform === 'win32') {
		const appData = process.env['APPDATA'] || join(home, 'AppData', 'Roaming');
		return join(appData, APP_NAME);
	}

	if (process.platform === 'darwin') {
		return join(home, 'Library', 'Application Support', APP_NAME);
	}

	const xdg = process.env['XDG_CONFIG_HOME'] || join(home, '.config');
	return join(xdg, APP_NAME);
}

function daemonInfoPath(): string {
	return join(getConfigDir(), 'daemon.json');
}

function daemonInstallDir(): string {
	return join(getConfigDir(), 'daemon', 'bin');
}

function daemonMetadataPath(): string {
	return join(getConfigDir(), 'daemon', 'installed-release.json');
}

function daemonPlatformName(): string {
	switch (process.platform) {
		case 'linux': {
			return 'linux';
		}

		case 'darwin': {
			return 'macos';
		}

		case 'win32': {
			return 'windows';
		}

		default: {
			throw new Error(
				`Unsupported platform for daemon binary: ${process.platform}`,
			);
		}
	}
}

function daemonArchName(): string {
	switch (process.arch) {
		case 'x64': {
			return 'x64';
		}

		case 'arm64': {
			return 'arm64';
		}

		default: {
			throw new Error(
				`Unsupported CPU architecture for daemon binary: ${process.arch}`,
			);
		}
	}
}

function daemonBinaryFilename(): string {
	const extension = process.platform === 'win32' ? '.exe' : '';
	return `minenet-app-server-${daemonPlatformName()}-${daemonArchName()}${extension}`;
}

function daemonBinaryPath(): string {
	return join(daemonInstallDir(), daemonBinaryFilename());
}

async function readDaemonInfo(): Promise<DaemonInfo | null> {
	const path = daemonInfoPath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw) as DaemonInfo;
		if (!parsed?.port || !parsed?.token) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

async function pingDaemon(info: DaemonInfo): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
			method: 'GET',
		});
		if (!response.ok) {
			return false;
		}

		const body = (await response.json().catch(() => null)) as {
			ok?: boolean;
		} | null;
		return Boolean(body?.ok);
	} catch {
		return false;
	}
}

function resolveAppServerDir(): string {
	if (process.env['MINENET_DAEMON_DIR']) {
		return process.env['MINENET_DAEMON_DIR'];
	}

	const thisDir = dirname(fileURLToPath(import.meta.url));
	return resolve(thisDir, '../../app-server');
}

function hasLocalAppServerSource(): boolean {
	const appServerDir = resolveAppServerDir();
	return (
		existsSync(join(appServerDir, 'index.ts')) &&
		existsSync(join(appServerDir, 'package.json'))
	);
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
	const headers = new Headers({
		accept: 'application/vnd.github+json',
		'user-agent': 'minenet-cli',
	});

	if (process.env['GITHUB_TOKEN']) {
		headers.set('authorization', `Bearer ${process.env['GITHUB_TOKEN']}`);
	}

	const response = await fetch(APP_SERVER_REPO, {
		method: 'GET',
		headers,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(
			`Failed to fetch app-server release metadata (${response.status})${
				detail ? `: ${detail}` : ''
			}`,
		);
	}

	const release = (await response.json()) as GitHubRelease;
	if (!release?.tag_name || !Array.isArray(release.assets)) {
		throw new Error('Invalid app-server release payload from GitHub');
	}

	return release;
}

function resolveAsset(
	release: GitHubRelease,
	expectedName: string,
): GitHubReleaseAsset {
	const exact = release.assets.find(asset => asset.name === expectedName);
	if (exact) {
		return exact;
	}

	const fallback = release.assets.find(asset =>
		asset.name.startsWith(expectedName.replace(/\.exe$/, '')),
	);
	if (fallback) {
		return fallback;
	}

	const available = release.assets.map(asset => asset.name).join(', ');
	throw new Error(
		`No matching app-server binary asset '${expectedName}' in release ${release.tag_name}. Available: ${available}`,
	);
}

async function installDaemonBinaryIfMissing(): Promise<string> {
	const binaryPath = daemonBinaryPath();
	if (existsSync(binaryPath)) {
		return binaryPath;
	}

	await mkdir(daemonInstallDir(), {recursive: true});

	const release = await fetchLatestRelease();
	const expectedName = daemonBinaryFilename();
	const asset = resolveAsset(release, expectedName);

	const response = await fetch(asset.browser_download_url, {
		method: 'GET',
		headers: {
			'user-agent': 'minenet-cli',
		},
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(
			`Failed to download daemon binary (${response.status})${
				detail ? `: ${detail}` : ''
			}`,
		);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	const tmpPath = `${binaryPath}.tmp-${Date.now()}-${process.pid}`;
	await writeFile(tmpPath, bytes);
	if (process.platform !== 'win32') {
		await chmod(tmpPath, 0o755);
	}

	await rename(tmpPath, binaryPath);
	if (process.platform !== 'win32') {
		await chmod(binaryPath, 0o755);
	}

	const metadata = {
		tag: release.tag_name,
		asset: asset.name,
		downloadUrl: asset.browser_download_url,
		installedAt: Date.now(),
	};
	await mkdir(dirname(daemonMetadataPath()), {recursive: true});
	await writeFile(
		daemonMetadataPath(),
		`${JSON.stringify(metadata, null, 2)}\n`,
		'utf8',
	);

	return binaryPath;
}

async function resolveDaemonLaunchSpec(): Promise<DaemonLaunchSpec> {
	if (process.env['MINENET_DAEMON_COMMAND']) {
		const command = process.env['MINENET_DAEMON_COMMAND'];
		const args = (process.env['MINENET_DAEMON_ARGS'] || 'run index.ts')
			.split(' ')
			.filter(Boolean);
		return {
			command,
			args,
			cwd: resolveAppServerDir(),
		};
	}

	if (process.env['MINENET_DAEMON_BINARY']) {
		const binary = process.env['MINENET_DAEMON_BINARY'];
		if (!existsSync(binary)) {
			throw new Error(
				`MINENET_DAEMON_BINARY is set but file does not exist: ${binary}`,
			);
		}

		return {
			command: binary,
			args: [],
		};
	}

	try {
		const installedBinary = await installDaemonBinaryIfMissing();
		return {
			command: installedBinary,
			args: [],
		};
	} catch (error) {
		if (hasLocalAppServerSource()) {
			return {
				command: 'bun',
				args: ['run', 'index.ts'],
				cwd: resolveAppServerDir(),
			};
		}

		const message =
			error instanceof Error ? error.message : 'Unknown download error';
		throw new Error(
			`Unable to install app-server daemon automatically: ${message}`,
		);
	}
}

async function spawnDaemon(): Promise<void> {
	await mkdir(getConfigDir(), {recursive: true});
	const spec = await resolveDaemonLaunchSpec();

	const child = spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		detached: true,
		stdio: 'ignore',
		env: {
			...process.env,
			MINENET_DAEMON_PORT: process.env['MINENET_DAEMON_PORT'] || '0',
		},
	});
	child.unref();
}

async function waitForDaemon(timeoutMs = 15000): Promise<DaemonInfo> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const info = await readDaemonInfo();
		if (info && (await pingDaemon(info))) {
			return info;
		}

		await new Promise(resolvePromise => {
			setTimeout(resolvePromise, 250);
		});
	}

	throw new Error('Timed out waiting for local daemon startup');
}

export async function ensureDaemon(): Promise<DaemonInfo> {
	const existing = await readDaemonInfo();
	if (existing && (await pingDaemon(existing))) {
		return existing;
	}

	await spawnDaemon();
	return waitForDaemon();
}

export async function daemonRequest<T>(input: {
	path: string;
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	body?: unknown;
}): Promise<T> {
	const daemon = await ensureDaemon();
	const method = input.method ?? 'GET';

	const headers = new Headers();
	headers.set('x-minenet-daemon-token', daemon.token);

	let body: string | undefined;
	if (input.body !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(input.body);
	}

	const response = await fetch(`http://127.0.0.1:${daemon.port}${input.path}`, {
		method,
		headers,
		body,
	});

	const text = await response.text();
	let payload: unknown = null;
	if (text.trim()) {
		try {
			payload = JSON.parse(text) as unknown;
		} catch {
			payload = text;
		}
	}

	if (!response.ok) {
		const message =
			typeof payload === 'object' && payload && 'error' in payload
				? String((payload as Record<string, unknown>)['error'])
				: `Daemon request failed (${response.status})`;
		const error = new Error(message) as Error & {
			status?: number;
			payload?: unknown;
		};
		error.status = response.status;
		error.payload = payload;
		throw error;
	}

	return payload as T;
}
