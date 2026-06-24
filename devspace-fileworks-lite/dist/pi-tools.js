import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, } from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
const require = createRequire(import.meta.url);
const nodePathEntries = (process.env.NODE_PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
const iconvLite = require(require.resolve("iconv-lite", {
    paths: [...nodePathEntries, "D:/npm-global/node_modules/@waishnav/devspace/node_modules"],
}));
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8LenientDecoder = new TextDecoder("utf-8");
const gb18030Decoder = new TextDecoder("gb18030");
const utf16leDecoder = new TextDecoder("utf-16le");
const utf8Encoder = new TextEncoder();
function toMcpContent(result) {
    return result.content.map((content) => {
        if (content.type === "text") {
            return { type: "text", text: content.text };
        }
        return {
            type: "image",
            data: content.data,
            mimeType: content.mimeType,
        };
    });
}
function formatToolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ type: "text", text: message }];
}
async function runTool(execute, input, context) {
    try {
        const result = await execute(input);
        return {
            content: toMcpContent(result),
            details: result.details,
        };
    }
    catch (error) {
        return { content: formatToolError(error), isError: true };
    }
}
function windowsCmdPayload(command) {
    const match = String(command ?? "").match(/^\s*cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i);
    return match?.[1]?.trim();
}
function isValidUtf8(buffer) {
    try {
        utf8Decoder.decode(buffer);
        return true;
    }
    catch {
        return false;
    }
}
function swapUtf16Bytes(buffer) {
    const output = Buffer.from(buffer);
    for (let i = 0; i + 1 < output.length; i += 2) {
        const byte = output[i];
        output[i] = output[i + 1];
        output[i + 1] = byte;
    }
    return output;
}
function detectTextEncoding(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return "utf8-bom";
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return "utf16le";
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        return "utf16be";
    }
    return isValidUtf8(buffer) ? "utf8" : "gb18030";
}
function decodeTextBuffer(buffer) {
    const encoding = detectTextEncoding(buffer);
    if (encoding === "utf8-bom") {
        return { encoding, text: utf8LenientDecoder.decode(buffer.subarray(3)) };
    }
    if (encoding === "utf16le") {
        return { encoding, text: utf16leDecoder.decode(buffer.subarray(2)) };
    }
    if (encoding === "utf16be") {
        return { encoding, text: utf16leDecoder.decode(swapUtf16Bytes(buffer.subarray(2))) };
    }
    if (encoding === "gb18030") {
        return { encoding, text: gb18030Decoder.decode(buffer) };
    }
    return { encoding, text: utf8LenientDecoder.decode(buffer) };
}
function encodeTextBuffer(text, encoding) {
    if (encoding === "utf8-bom") {
        return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Encoder.encode(text))]);
    }
    if (encoding === "utf16le") {
        return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    }
    if (encoding === "utf16be") {
        return Buffer.concat([Buffer.from([0xfe, 0xff]), swapUtf16Bytes(Buffer.from(text, "utf16le"))]);
    }
    if (encoding === "gb18030") {
        return iconvLite.encode(text, "gb18030");
    }
    return Buffer.from(utf8Encoder.encode(text));
}
function detectSupportedImageMimeType(buffer) {
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a) {
        return "image/png";
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    const header = buffer.subarray(0, 12).toString("ascii");
    if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
        return "image/gif";
    }
    if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
        return "image/webp";
    }
    return undefined;
}
async function readTextAsUtf8Buffer(path) {
    const buffer = await fsReadFile(path);
    const { text } = decodeTextBuffer(buffer);
    return Buffer.from(utf8Encoder.encode(text));
}
async function readTextFile(path) {
    const buffer = await fsReadFile(path);
    return decodeTextBuffer(buffer).text;
}
async function readFilePreservingBinary(path) {
    const buffer = await fsReadFile(path);
    if (detectSupportedImageMimeType(buffer)) {
        return buffer;
    }
    const { text } = decodeTextBuffer(buffer);
    return Buffer.from(utf8Encoder.encode(text));
}
async function detectImageMimeTypeFromFile(path) {
    return detectSupportedImageMimeType(await fsReadFile(path));
}
async function writeTextPreservingEncoding(path, content) {
    let encoding = "utf8";
    try {
        encoding = detectTextEncoding(await fsReadFile(path));
    }
    catch {
        encoding = "utf8";
    }
    await fsWriteFile(path, encodeTextBuffer(content, encoding));
}
function textFileOperations() {
    return {
        read: {
            readFile: readFilePreservingBinary,
            access: (path) => fsAccess(path, constants.R_OK),
            detectImageMimeType: detectImageMimeTypeFromFile,
        },
        write: {
            writeFile: writeTextPreservingEncoding,
            mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => { }),
        },
        edit: {
            readFile: readTextAsUtf8Buffer,
            writeFile: writeTextPreservingEncoding,
            access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
        },
        grep: {
            isDirectory: async (path) => (await fsStat(path)).isDirectory(),
            readFile: readTextFile,
        },
    };
}
function runWindowsCmdTool(command, timeout, context) {
    return new Promise((resolve) => {
        const payload = command;
        const decoder = new TextDecoder("gb18030");
        execFile("cmd.exe", ["/d", "/s", "/c", payload], {
            cwd: context.cwd,
            timeout: timeout * 1000,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024,
            encoding: "buffer",
        }, (error, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) => {
            const output = `${decoder.decode(stdout)}${decoder.decode(stderr)}`.trimEnd();
            const exitCode = typeof error?.code === "number" ? error.code : 0;
            const timedOut = Boolean(error?.killed);
            const text = output || (timedOut ? `Command timed out after ${timeout}s` : "");
            resolve({
                content: [{ type: "text", text }],
                details: {
                    command: `cmd.exe /d /s /c ${command}`,
                    exitCode,
                    timedOut,
                },
                isError: Boolean(error),
            });
        });
    });
}
export async function readFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
    const tool = createReadTool(context.cwd, { operations: textFileOperations().read });
    return runTool((params) => tool.execute("read_file", params), {
        path,
        offset: input.offset,
        limit: input.limit,
    }, context);
}
export async function writeFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createWriteTool(context.cwd, { operations: textFileOperations().write });
    return runTool((params) => tool.execute("write_file", params), {
        path,
        content: input.content,
    }, context);
}
export async function editFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createEditTool(context.cwd, { operations: textFileOperations().edit });
    return runTool((params) => tool.execute("edit_file", params), {
        path,
        edits: input.edits,
    }, context);
}
export async function grepFilesTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createGrepTool(context.cwd, { operations: textFileOperations().grep });
    return runTool((params) => tool.execute("grep_files", params), input, context);
}
export async function findFilesTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createFindTool(context.cwd);
    return runTool((params) => tool.execute("find_files", params), input, context);
}
export async function listDirectoryTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createLsTool(context.cwd);
    return runTool((params) => tool.execute("list_directory", params), input, context);
}
export async function runShellTool(input, context) {
    const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
    const cmdPayload = process.platform === "win32" ? windowsCmdPayload(input.command) : undefined;
    if (cmdPayload) {
        return runWindowsCmdTool(cmdPayload, timeout, context);
    }
    const tool = createBashTool(context.cwd);
    return runTool((params) => tool.execute("run_shell", params), {
        command: input.command,
        timeout,
    }, context);
}
