import {existsSync} from 'node:fs';
import {mkdir, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

type DaemonInfo = {
	version: 1;
	port: number;
	token: string;
	pid: number;
	startedAt: number;
};

const APP_NAME = 'minenet';

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

async function spawnDaemon(): Promise<void> {
	await mkdir(getConfigDir(), {recursive: true});

	const appServerDir = resolveAppServerDir();
	const command = process.env['MINENET_DAEMON_COMMAND'] || 'bun';
	const args = (process.env['MINENET_DAEMON_ARGS'] || 'run index.ts')
		.split(' ')
		.filter(Boolean);

	const child = spawn(command, args, {
		cwd: appServerDir,
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
