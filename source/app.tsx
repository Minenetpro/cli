import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp} from 'ink';
import {executeCommand} from './commands.js';
import type {CliFlags} from './types.js';

type Props = {
	command: string;
	args: string[];
	flags: CliFlags;
	version: string;
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PHASE_LABELS: Record<string, string> = {
	sync: 'Syncing workspace',
	queue: 'Queueing deploy runs',
	monitor: 'Monitoring runs',
	detached: 'Detached mode',
	done: 'Completed',
	failed: 'Failed',
	blocked: 'Blocked',
};

function colorForLog(line: string): string {
	const normalized = line.toLowerCase();

	if (
		normalized.includes('succeeded') ||
		normalized.includes('completed') ||
		normalized.startsWith('pushed ')
	) {
		return 'green';
	}

	if (normalized.startsWith('+') && !normalized.startsWith('+ ')) {
		return 'green';
	}

	if (normalized.startsWith('-') && !normalized.startsWith('- ')) {
		return 'red';
	}

	if (
		normalized.startsWith('error:') ||
		normalized.includes('blocked') ||
		/\bfailed\b:/.test(normalized) ||
		/\bcanceled\b:/.test(normalized)
	) {
		return 'red';
	}

	if (normalized.startsWith('queued ') || normalized.includes('run ')) {
		return 'cyan';
	}

	if (normalized.includes(' diff ') || normalized.includes('version')) {
		return 'cyan';
	}

	return 'white';
}

export default function App({command, args, flags, version}: Props) {
	const {exit} = useApp();
	const [logs, setLogs] = useState<string[]>([]);
	const [phase, setPhase] = useState<string>('');
	const [running, setRunning] = useState(true);
	const [ok, setOk] = useState<boolean | null>(null);
	const [frameIndex, setFrameIndex] = useState(0);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrameIndex(current => (current + 1) % FRAMES.length);
		}, 80);

		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const timer = setInterval(() => {
			setElapsedSeconds(current => current + 1);
		}, 1000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		let cancelled = false;

		const run = async () => {
			try {
				const result = await executeCommand({
					command,
					args,
					flags,
					cwd: process.cwd(),
					version,
					onProgress: update => {
						if (cancelled) {
							return;
						}

						if (update.phase) {
							setPhase(update.phase);
						}

						const logLine = update.log;
						if (typeof logLine === 'string') {
							setLogs(current => [...current, logLine]);
						}
					},
				});

				if (cancelled) {
					return;
				}

				if (result.logs.length > 0) {
					setLogs(current => [...current, ...result.logs]);
				}

				if (flags.json) {
					const payload = result.payload ?? {ok: result.ok};
					setLogs([JSON.stringify(payload, null, 2)]);
				}

				setOk(result.ok);
				setRunning(false);
				process.exitCode = result.exitCode;

				setTimeout(() => {
					if (!cancelled) {
						exit();
					}
				}, 0);
			} catch (error) {
				if (cancelled) {
					return;
				}

				const message =
					error instanceof Error ? error.message : 'Unexpected error';
				setLogs(current => [...current, `Error: ${message}`]);
				setPhase('failed');
				setOk(false);
				setRunning(false);
				process.exitCode = 1;
				setTimeout(() => {
					if (!cancelled) {
						exit();
					}
				}, 0);
			}
		};

		run().catch(error => {
			const message =
				error instanceof Error ? error.message : 'Unexpected error';
			setLogs(current => [...current, `Error: ${message}`]);
			setPhase('failed');
			setOk(false);
			setRunning(false);
			process.exitCode = 1;
			exit();
		});

		return () => {
			cancelled = true;
		};
	}, [args, command, exit, flags, version]);

	const header = useMemo(() => {
		if (running) {
			return `${FRAMES[frameIndex]} minenet ${command}`;
		}
		if (ok) {
			return `✓ minenet ${command}`;
		}
		return `✗ minenet ${command}`;
	}, [command, frameIndex, ok, running]);

	const phaseLabel = phase ? PHASE_LABELS[phase] ?? phase : '';

	return (
		<Box flexDirection="column">
			<Box
				borderStyle="round"
				borderColor={running ? 'cyan' : ok ? 'green' : 'red'}
				paddingX={1}
				flexDirection="column"
			>
				<Text color={running ? 'cyan' : ok ? 'green' : 'red'}>{header}</Text>
				{phaseLabel ? (
					<Text color={running ? 'yellow' : ok ? 'green' : 'red'}>
						{`Phase: ${phaseLabel} · ${elapsedSeconds}s`}
					</Text>
				) : (
					<Text dimColor>{`Elapsed: ${elapsedSeconds}s`}</Text>
				)}
			</Box>
			{logs.map((line, index) => (
				<Text key={`${index}-${line}`} color={colorForLog(line)}>
					{`  ${line}`}
				</Text>
			))}
		</Box>
	);
}
