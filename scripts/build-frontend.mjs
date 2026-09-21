import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(projectRoot, "src");
const cacheFile = resolve(
	projectRoot,
	"node_modules",
	".cache",
	"local-test-lab-vite-build.sha256",
);
const requiredOutputs = [
	"src/main/index.html",
	"src/background/index.html",
	"src/queryMatch/index.html",
	"src/recentMatch/index.html",
];

const staticInputs = [
	"index.html",
	"package.json",
	"pnpm-lock.yaml",
	"vite.config.ts",
	"tsconfig.json",
	"tsconfig.node.json",
	"tailwind.config.js",
	"postcss.config.js",
];

function collectFiles(directory) {
	const files = [];

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectFiles(entryPath));
		} else if (entry.isFile()) {
			files.push(entryPath);
		}
	}

	return files;
}

function hasRequiredOutputs() {
	return requiredOutputs.every((file) => existsSync(resolve(projectRoot, "dist", file)));
}

function getFingerprint() {
	const hash = createHash("sha256");
	const inputFiles = [
		...staticInputs.map((file) => resolve(projectRoot, file)),
		...collectFiles(sourceRoot),
	].sort();
	const buildEnvironment = Object.fromEntries(
		Object.entries(process.env)
			.filter(([key]) => key.startsWith("VITE_") || key.startsWith("TAURI_ENV_"))
			.sort(([left], [right]) => left.localeCompare(right)),
	);

	hash.update(JSON.stringify({ args: process.argv.slice(2), buildEnvironment }));
	for (const file of inputFiles) {
		hash.update(`\0${relative(projectRoot, file)}\0`);
		hash.update(readFileSync(file));
	}

	return hash.digest("hex");
}

const fingerprint = getFingerprint();
const cachedFingerprint = existsSync(cacheFile)
	? readFileSync(cacheFile, "utf8").trim()
	: "";

if (cachedFingerprint === fingerprint && hasRequiredOutputs()) {
	console.log("Frontend inputs unchanged; skipping Vite build.");
	process.exit(0);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpmCommand, ["exec", "vite", "build", ...process.argv.slice(2)], {
	cwd: projectRoot,
	env: process.env,
	shell: process.platform === "win32",
	stdio: "inherit",
});

if (result.error || result.status !== 0) {
	process.exit(result.status ?? 1);
}

mkdirSync(dirname(cacheFile), { recursive: true });
writeFileSync(cacheFile, `${fingerprint}\n`, "utf8");
