import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";
const REVIEW_REF_PREFIX = "refs/devspace/review";
export function createReviewCheckpointManager() {
    const states = new Map();
    return {
        async initializeWorkspace({ workspaceId, root }) {
            const refs = reviewRefs(workspaceId);
            const state = { root, ...refs };
            states.set(workspaceId, state);
            try {
                const eligibility = await getGitEligibility(root);
                if (!eligibility.ok || !eligibility.gitRoot) {
                    state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
                    return;
                }
                state.gitRoot = eligibility.gitRoot;
                const commit = await createWorkingTreeSnapshot(eligibility.gitRoot);
                await git(eligibility.gitRoot, ["update-ref", state.openRef, commit]);
                await git(eligibility.gitRoot, ["update-ref", state.baselineRef, commit]);
            }
            catch (error) {
                state.diagnostic = error instanceof Error ? error.message : String(error);
            }
        },
        async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
            let state = states.get(workspaceId);
            if (!state) {
                await this.initializeWorkspace({ workspaceId, root });
                state = states.get(workspaceId);
            }
            if (!state?.gitRoot) {
                throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
            }
            const baselineRef = since === "workspace_open" ? state.openRef : state.baselineRef;
            const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
            const current = await createWorkingTreeSnapshot(state.gitRoot);
            const patch = (await git(state.gitRoot, ["diff", "--binary", "--no-color", baseline, current], {
                maxBuffer: 50 * 1024 * 1024,
            })).stdout;
            const numstat = (await git(state.gitRoot, ["diff", "--numstat", "-z", baseline, current], {
                maxBuffer: 50 * 1024 * 1024,
            })).stdout;
            const files = parseNumstat(numstat);
            const summary = summarizeFiles(files);
            if (markReviewed) {
                await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
            }
            return {
                result: summary.files === 0
                    ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
                    : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
                summary,
                files,
                patch,
            };
        },
    };
}
function reviewRefs(workspaceId) {
    const segment = safeWorkspaceRefSegment(workspaceId);
    return {
        openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
        baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
    };
}
async function createWorkingTreeSnapshot(gitRoot) {
    const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
    const indexPath = join(tempDir, "index");
    const env = checkpointEnv(indexPath);
    try {
        await git(gitRoot, ["read-tree", "HEAD"], { env });
        await git(gitRoot, ["add", "-A", "--", "."], { env });
        const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
        const parent = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
        return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
    }
    finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
function checkpointEnv(indexPath) {
    return {
        GIT_INDEX_FILE: indexPath,
        GIT_AUTHOR_NAME: "DevSpace",
        GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
        GIT_COMMITTER_NAME: "DevSpace",
        GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
    };
}
function parseNumstat(output) {
    const fields = output.split("\0").filter((field) => field.length > 0);
    const files = [];
    for (let index = 0; index < fields.length;) {
        const header = fields[index++] ?? "";
        const parts = header.split("\t");
        const additions = parseStatNumber(parts[0]);
        const removals = parseStatNumber(parts[1]);
        if (parts.length >= 3) {
            const path = parts[2] ?? "";
            if (path)
                files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
            continue;
        }
        const previousPath = fields[index++];
        const path = fields[index++];
        if (!path)
            continue;
        files.push({
            path,
            previousPath,
            type: fileType(path, previousPath, additions, removals),
            additions,
            removals,
        });
    }
    return files;
}
function parseStatNumber(value) {
    if (!value || value === "-")
        return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function fileType(path, previousPath, additions, removals) {
    if (previousPath)
        return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
    if (additions > 0 && removals === 0)
        return "new";
    if (additions === 0 && removals > 0)
        return "deleted";
    return "change";
}
function summarizeFiles(files) {
    return files.reduce((summary, file) => ({
        files: summary.files + 1,
        additions: summary.additions + file.additions,
        removals: summary.removals + file.removals,
    }), { files: 0, additions: 0, removals: 0 });
}
