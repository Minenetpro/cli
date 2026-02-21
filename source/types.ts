export type CliFlags = {
	json: boolean;
	force: boolean;
	workspace?: string;
	config?: string;
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
