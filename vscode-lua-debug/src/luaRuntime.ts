import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { Writable } from 'stream';

export interface LuaBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

class LuaCommands {
	constructor(private stdin: Writable) {
	}

	public pause(): void {
		this.commandLine('pause(\'start debugging\', 1, true)');
	}

	public step(): void {
		this.commandLine('step');
		this.commandLine('vars');
	}

	public loadFile(path: string): void {
		const debuggerLuaFilePath = path.replace(/\\/g, '/');
		this.stdin.write(`dofile('${debuggerLuaFilePath}')\n`, () => {
			console.log('<<< done: loaded file: ' + debuggerLuaFilePath);
		});
	}

	public loadDebuggerSourceAsRequire(): void {
		this.stdin.write(`require('./debugger')\n`, () => {
			console.log('<<< done: loaded debugger');
		});
	}

	public commandLine(cmd: string): void {
		this.stdin.write(cmd + '\n', () => {
			console.log('<<< done: ' + cmd);
		});
	}
}

class LuaSpawnedDebugProcess {
	private _version: boolean;
	private _loadingDebugger: boolean;
	private _loadedDebugger: boolean;
	private _loadedFile: boolean;
    private _commands: LuaCommands;
    private luaExe: ChildProcess;

	constructor(private program: string, private stopOnEntry: boolean, private luaExecutable: string) {
	}

	public async spawn() {
		const luaExe = this.luaExe = spawn(this.luaExecutable, ['-i']);

		this._commands = new LuaCommands(luaExe.stdin);

		luaExe.stderr.on('data', (data) => {
			console.error(data.toString());
		});

		luaExe.on('exit', (code) => {
			console.log(`Lua Debug process exited with code ${code}`);
        });

        luaExe.stdout.setEncoding('utf8');
        let line;
        while (line = await this.readOutput(3000)) {
            if (line === null) {
                console.log('end of input');
                break;
            }

            console.log(">>> output: " + line);

			if (line.startsWith('Lua 5.3.')) {
				this._version = true;
			}

			if (line.startsWith('>')) {
				this._commands.loadDebuggerSourceAsRequire();
                this._loadingDebugger = true;
            }

            if (line.startsWith('true')) {
                this._loadedDebugger = true;
                ////this._commands.loadFile(this.program);
                this._commands.pause();
                this._commands.pause();
                this._loadedFile = false;
                break;
            }
        }

        console.log(">>> exit start program");
	}

	public async step(reverse: boolean, event?: string) {
        this._commands.step();

        let line;
        while (line = await this.readOutput(3000)) {
            if (line === null) {
                console.log('end of input');
                break;
            }
        }
    }

    private async readOutput(timeout?: number) {
        return new Promise((resolve, reject) => {
            let timerId;
            this.luaExe.stdout.on('data', (data) => {
                if (timerId) {
                    clearTimeout(timerId);
                }

                resolve(data);
            });

            this.luaExe.stdout.on('error', () => {
                if (timerId) {
                    clearTimeout(timerId);
                }

                resolve(undefined);
            });

            if (timeout) {
                timerId = setTimeout(() => resolve(undefined), timeout);
            }
        });
    }
}

/**
 * A lua runtime with minimal debugger functionality.
 */
export class LuaRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	// the contents (= lines) of the one and only file
	private _sourceLines: string[];

	// This is the next line that will be 'executed'
	private _currentLine = 0;

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, LuaBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _luaExe: LuaSpawnedDebugProcess;

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean, luaExecutable: string) {
		this.loadSource(program);
		this._currentLine = -1;

		this._luaExe = new LuaSpawnedDebugProcess(program, stopOnEntry, luaExecutable);
		await this._luaExe.spawn();

		this.verifyBreakpoints(this._sourceFile);

		if (stopOnEntry) {
			// we step once
			await this.step(false, 'stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			await this.continue();
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public async continue(reverse = false) {
		await this.run(reverse, undefined);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public async step(reverse = false, event = 'stopOnStep') {
		await this.run(reverse, event);
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): any {

		const words = this._sourceLines[this._currentLine].trim().split(/\s+/);

		const frames = new Array<any>();
		// every word of the current line becomes a stack frame.
		for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
			const name = words[i];	// use a word of the line as the stackframe name
			frames.push({
				index: i,
				name: `${name}(${i})`,
				file: this._sourceFile,
				line: this._currentLine
			});
		}
		return {
			frames: frames,
			count: words.length
		};
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number): LuaBreakpoint {

		const bp = <LuaBreakpoint>{ verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<LuaBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoints(path);

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): LuaBreakpoint | undefined {
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
	}

	// private methods

	private loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		}
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private async run(reverse = false, stepEvent?: string) {
        await this._luaExe.step(reverse, stepEvent);

        if (reverse) {
			for (let ln = this._currentLine - 1; ln >= 0; ln--) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return;
				}
            }

			// no more lines: stop at first line
			this._currentLine = 0;
			this.sendEvent('stopOnEntry');
		} else {
			for (let ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return true;
				}
			}
			// no more lines: run to end
			this.sendEvent('end');
		}
	}

	private verifyBreakpoints(path: string): void {
		let bps = this._breakPoints.get(path);
		if (bps) {
			this.loadSource(path);
			bps.forEach(bp => {
				if (!bp.verified && bp.line < this._sourceLines.length) {
					const srcLine = this._sourceLines[bp.line].trim();

					// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
					if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
						bp.line++;
					}
					// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
					if (srcLine.indexOf('-') === 0) {
						bp.line--;
					}
					// don't set 'verified' to true if the line contains the word 'lazy'
					// in this case the breakpoint will be verified 'lazy' after hitting it once.
					if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}
				}
			});
		}
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	private fireEventsForLine(ln: number, stepEvent?: string): boolean {

		const line = this._sourceLines[ln].trim();

		// if 'log(...)' found in source -> send argument to debug console
		const matches = /log\((.*)\)/.exec(line);
		if (matches && matches.length === 2) {
			this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
		}

		// if word 'exception' found in source -> throw exception
		if (line.indexOf('exception') >= 0) {
			this.sendEvent('stopOnException');
			return true;
		}

		// is there a breakpoint?
		const breakpoints = this._breakPoints.get(this._sourceFile);
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {

				// send 'stopped' event
				this.sendEvent('stopOnBreakpoint');

				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.sendEvent('breakpointValidated', bps[0]);
				}
				return true;
			}
		}

		// non-empty line
		if (stepEvent && line.length > 0) {
			this.sendEvent(stepEvent);
			return true;
		}

		// nothing interesting found -> continue
		return false;
	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}