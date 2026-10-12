// Landlock through bun:ffi and libc (Linux only): the ABI version, a restriction of this process's
// write rights to some places, and execve. A restriction is inherited by every process started
// afterwards and cannot be lifted.
import * as fs from "node:fs";
import { dlopen, FFIType, ptr, read } from "bun:ffi";

const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;
const PR_SET_NO_NEW_PRIVS = 38;
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;

const WRITE_FILE = 1n << 1n;
const REMOVE_DIR = 1n << 4n;
const REMOVE_FILE = 1n << 5n;
const MAKE_CHAR = 1n << 6n;
const MAKE_DIR = 1n << 7n;
const MAKE_REG = 1n << 8n;
const MAKE_SOCK = 1n << 9n;
const MAKE_FIFO = 1n << 10n;
const MAKE_BLOCK = 1n << 11n;
const MAKE_SYM = 1n << 12n;
const REFER = 1n << 13n;
const TRUNCATE = 1n << 14n;

function openLibc() {
	return dlopen("libc.so.6", {
		syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
		prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
		open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		close: { args: [FFIType.i32], returns: FFIType.i32 },
		execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	}).symbols;
}

let libc: ReturnType<typeof openLibc> | undefined;

function lib(): ReturnType<typeof openLibc> {
	if (process.platform !== "linux") throw new Error("Landlock is only available on Linux");
	libc ??= openLibc();
	return libc;
}

function cString(value: string): Buffer {
	return Buffer.from(`${value}\0`);
}

function errnoError(call: string): Error {
	const location = lib().__errno_location();
	const errno = location ? read.i32(location, 0) : 0;
	const name = Object.entries(fs.constants).find(([key, value]) => key.startsWith("E") && value === errno)?.[0];
	return new Error(`${call} failed (errno ${errno}${name ? ` ${name}` : ""})`);
}

/** The Landlock ABI version the kernel offers, or 0 when Landlock cannot be used. */
export function landlockAbi(): number {
	try {
		const version = Number(lib().syscall(SYS_LANDLOCK_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION, 0));
		return version > 0 ? version : 0;
	} catch {
		return 0;
	}
}

/** Every write right this ABI can handle: changing, creating, removing, renaming, and truncating. */
export function writeRights(abi: number): bigint {
	let rights = WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM;
	if (abi >= 2) rights |= REFER;
	if (abi >= 3) rights |= TRUNCATE;
	return rights;
}

export interface Rule {
	path: string;
	/** `write`: every write right below the path; `device`: writing to existing files only (for /dev). */
	access: "write" | "device";
}

/**
 * Restricts this process, and everything it starts later, to writing only below the given paths.
 * A path that cannot be opened is skipped, which leaves fewer rights, never more. Throws when the
 * restriction cannot be applied.
 */
export function restrictWrites(rules: readonly Rule[]): { abi: number; skipped: string[] } {
	const abi = landlockAbi();
	if (abi < 1) throw new Error("Landlock is not available (kernel without Landlock, or it is disabled)");
	const c = lib();
	const handled = writeRights(abi);
	const fileRights = handled & (WRITE_FILE | TRUNCATE);
	const attr = new BigUint64Array([handled]);
	const rulesetFd = Number(c.syscall(SYS_LANDLOCK_CREATE_RULESET, ptr(attr), 8, 0, 0));
	if (rulesetFd < 0) throw errnoError("landlock_create_ruleset");
	const skipped: string[] = [];
	try {
		for (const rule of rules) {
			const fd = c.open(ptr(cString(rule.path)), O_PATH | O_CLOEXEC);
			if (fd < 0) {
				skipped.push(rule.path);
				continue;
			}
			try {
				const directory = fs.statSync(rule.path).isDirectory();
				const access = rule.access === "device" ? WRITE_FILE : directory ? handled : fileRights;
				const beneath = new DataView(new ArrayBuffer(12));
				beneath.setBigUint64(0, access, true);
				beneath.setInt32(8, fd, true);
				const added = Number(c.syscall(SYS_LANDLOCK_ADD_RULE, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, ptr(new Uint8Array(beneath.buffer)), 0));
				if (added !== 0) throw errnoError(`landlock_add_rule (${rule.path})`);
			} finally {
				c.close(fd);
			}
		}
		if (c.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) throw errnoError("prctl(PR_SET_NO_NEW_PRIVS)");
		if (Number(c.syscall(SYS_LANDLOCK_RESTRICT_SELF, rulesetFd, 0, 0, 0)) !== 0) throw errnoError("landlock_restrict_self");
	} finally {
		c.close(rulesetFd);
	}
	return { abi, skipped };
}

/** Replaces this process with `file`. Returns only when that fails, with the error. */
export function execve(file: string, argv: readonly string[], env: Readonly<Record<string, string>>): Error {
	const c = lib();
	const args = argv.map(cString);
	const vars = Object.entries(env).map(([key, value]) => cString(`${key}=${value}`));
	const argPointers = new BigUint64Array(args.length + 1);
	args.forEach((arg, i) => {
		argPointers[i] = BigInt(ptr(arg));
	});
	const envPointers = new BigUint64Array(vars.length + 1);
	vars.forEach((entry, i) => {
		envPointers[i] = BigInt(ptr(entry));
	});
	c.execve(ptr(cString(file)), ptr(argPointers), ptr(envPointers));
	return errnoError(`execve ${file}`);
}
