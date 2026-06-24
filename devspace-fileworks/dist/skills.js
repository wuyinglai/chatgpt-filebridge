import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { loadSkills, } from "@earendil-works/pi-coding-agent";
import { expandHomePath, isPathInsideRoot } from "./roots.js";
export function loadWorkspaceSkills(config, cwd) {
    if (!config.skillsEnabled)
        return { skills: [], diagnostics: [] };
    return loadSkills({
        cwd,
        agentDir: config.agentDir,
        skillPaths: config.skillPaths,
        includeDefaults: true,
    });
}
export function resolveSkillReadPath(skills, activatedSkillDirs, inputPath) {
    const absolutePath = resolve(expandHomePath(inputPath));
    for (const skill of skills) {
        const skillFilePath = resolve(skill.filePath);
        if (absolutePath === skillFilePath) {
            return { absolutePath, skill, isSkillFile: true };
        }
    }
    for (const skill of skills) {
        const baseDir = resolve(skill.baseDir);
        if (!activatedSkillDirs.has(baseDir))
            continue;
        if (!isPathInsideRoot(absolutePath, baseDir))
            continue;
        return { absolutePath, skill, isSkillFile: false };
    }
    return undefined;
}
export function markSkillActivated(activatedSkillDirs, skill) {
    activatedSkillDirs.add(resolve(skill.baseDir));
}
export function formatPathForPrompt(path) {
    const home = resolve(homedir());
    const resolvedPath = resolve(path);
    if (resolvedPath === home)
        return "~";
    if (resolvedPath.startsWith(`${home}${sep}`)) {
        return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
    }
    return resolvedPath.split(sep).join("/");
}
