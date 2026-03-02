export type CliFlags = {
	json: boolean;
	debug: boolean;
	force: boolean;
	workspace?: string;
	config?: string;
	limit?: number;
	from?: string;
	to?: string;
	message?: string;
	detach: boolean;
	api?: string;
	prune: boolean;
	noOpen: boolean;
};

export type CommandResult = {
	ok: boolean;
	exitCode: number;
	logs: string[];
	payload?: unknown;
};

export type ProgressUpdate = {
	log?: string;
	phase?: string;
};
