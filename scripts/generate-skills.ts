#!/usr/bin/env npx tsx

/**
 * Generate SKILL.md and reference files for pi-custom-compactor by introspecting
 * the built extension and scanning seed specs.
 *
 * Architecture:
 * 1. Import the extension factory with a mock `pi` object that captures registrations
 * 2. Scan seeds/*.yaml and parse vocabulary (extracts, strategies, priorities, budgets)
 * 3. Read optional skill-narrative.md (YAML frontmatter + XML-tagged body)
 * 4. Compose skills/pi-custom-compactor/SKILL.md from registrations + vocabulary + narrative
 * 5. Write reference files (bundled-resources.md, spec-vocabulary.md)
 *
 * Run: npx tsx scripts/generate-skills.ts
 * Or:  npm run generate-skills
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEEDS_DIR = join(ROOT, "seeds");
const SKILL_NAME = "pi-custom-compactor";

// ── Types for captured registrations ────────────────────────────────────────

interface CommandRegistration {
	name: string;
	description: string;
}

interface EventRegistration {
	event: string;
}

interface EventBusRegistration {
	channel: string;
}

interface Registrations {
	commands: CommandRegistration[];
	events: EventRegistration[];
	eventBus: EventBusRegistration[];
}

// ── Types for parsed seed specs ─────────────────────────────────────────────

interface ParsedExtract {
	name: string;
	description: string;
	persist: string;
	format: string;
	strategy: string;
	maxTokens?: number;
	maxEntries?: number;
	priority?: string;
}

interface ParsedReassembleSource {
	source: string;
	as: string;
	wrap: string;
}

interface ParsedSpec {
	fileName: string;
	name: string;
	extracts: ParsedExtract[];
	budget?: number;
	overflow?: string;
	sources: ParsedReassembleSource[];
}

// ── Mock pi object ──────────────────────────────────────────────────────────

function createMockPi(): { mockPi: Record<string, unknown>; registrations: Registrations } {
	const registrations: Registrations = {
		commands: [],
		events: [],
		eventBus: [],
	};

	const noop = () => {};

	const mockPi = {
		on(event: string, _handler: unknown) {
			registrations.events.push({ event });
		},
		registerCommand(name: string, config: { description?: string }) {
			registrations.commands.push({
				name,
				description: config.description || "",
			});
		},
		events: {
			on(channel: string, _handler: unknown) {
				registrations.eventBus.push({ channel });
			},
		},
		// No-ops for other ExtensionAPI methods the factory might reference
		registerTool: noop,
		registerShortcut: noop,
		sendMessage: noop,
		registerMessageRenderer: noop,
		registerFlag: noop,
		setStatus: noop,
	};

	return { mockPi, registrations };
}

// ── Seed spec parsing ───────────────────────────────────────────────────────

function parseSeedSpecs(): ParsedSpec[] {
	if (!existsSync(SEEDS_DIR)) return [];

	const specs: ParsedSpec[] = [];

	for (const file of readdirSync(SEEDS_DIR).sort()) {
		if (!file.endsWith(".yaml")) continue;

		const content = readFileSync(join(SEEDS_DIR, file), "utf-8");
		const raw = parseYaml(content);
		if (!raw || typeof raw !== "object") continue;

		const name = file.replace(/\.yaml$/, "");
		const extracts: ParsedExtract[] = [];

		if (raw.extracts && typeof raw.extracts === "object") {
			for (const [eName, eRaw] of Object.entries(raw.extracts)) {
				const e = eRaw as Record<string, unknown>;
				extracts.push({
					name: eName,
					description: String(e.description || ""),
					persist: String(e.persist || ""),
					format: String(e.format || ""),
					strategy: String(e.strategy || ""),
					maxTokens: typeof e.maxTokens === "number" ? e.maxTokens : undefined,
					maxEntries: typeof e.maxEntries === "number" ? e.maxEntries : undefined,
					priority: typeof e.priority === "string" ? e.priority : undefined,
				});
			}
		}

		const reassemble = raw.reassemble as Record<string, unknown> | undefined;
		const sources: ParsedReassembleSource[] = [];
		if (reassemble?.sources && Array.isArray(reassemble.sources)) {
			for (const src of reassemble.sources) {
				sources.push({
					source: String(src.source || ""),
					as: String(src.as || ""),
					wrap: String(src.wrap || ""),
				});
			}
		}

		specs.push({
			fileName: file,
			name,
			extracts,
			budget: typeof reassemble?.budget === "number" ? reassemble.budget : undefined,
			overflow: typeof reassemble?.overflow === "string" ? reassemble.overflow : undefined,
			sources,
		});
	}

	return specs;
}

// ── Narrative frontmatter parsing ───────────────────────────────────────────

interface NarrativeParsed {
	frontmatter: Record<string, string> | null;
	body: string;
}

function parseNarrative(content: string): NarrativeParsed {
	if (!content.startsWith("---")) {
		return { frontmatter: null, body: content };
	}

	const endIdx = content.indexOf("\n---", 3);
	if (endIdx === -1) {
		return { frontmatter: null, body: content };
	}

	const yamlBlock = content.slice(4, endIdx).trim();
	const body = content.slice(endIdx + 4).trim();

	// Simple YAML parsing for the fields we care about
	const frontmatter: Record<string, string> = {};
	let currentKey: string | null = null;
	let currentValue = "";
	let isMultiline = false;

	for (const line of yamlBlock.split("\n")) {
		const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
		if (keyMatch && !isMultiline) {
			if (currentKey) frontmatter[currentKey] = currentValue.trim();
			currentKey = keyMatch[1];
			const val = keyMatch[2].trim();
			if (val === ">" || val === "|") {
				isMultiline = true;
				currentValue = "";
			} else {
				currentValue = val;
				isMultiline = false;
			}
		} else if (isMultiline && line.match(/^\s/)) {
			currentValue += (currentValue ? " " : "") + line.trim();
		} else if (isMultiline && !line.match(/^\s/) && line.trim()) {
			if (currentKey) frontmatter[currentKey] = currentValue.trim();
			const km = line.match(/^(\w[\w-]*):\s*(.*)/);
			if (km) {
				currentKey = km[1];
				currentValue = km[2].trim();
				isMultiline = false;
			}
		}
	}
	if (currentKey) frontmatter[currentKey] = currentValue.trim();

	return { frontmatter, body };
}

// ── SKILL.md composition ────────────────────────────────────────────────────

function composeSkill(
	registrations: Registrations,
	specs: ParsedSpec[],
	narrativeRaw: string | null,
	packageDescription: string,
): string {
	const lines: string[] = [];

	// Parse narrative
	const { frontmatter: narrativeFm, body: narrativeBody } = narrativeRaw
		? parseNarrative(narrativeRaw)
		: { frontmatter: null, body: null };

	const skillDescription = narrativeFm?.description || packageDescription;

	// ── YAML frontmatter ──
	lines.push("---");
	lines.push(`name: ${SKILL_NAME}`);
	if (skillDescription.length > 80 || skillDescription.includes("\n")) {
		lines.push("description: >");
		const words = skillDescription.split(/\s+/);
		let currentLine = "  ";
		for (const word of words) {
			if (currentLine.length + word.length + 1 > 82 && currentLine.trim()) {
				lines.push(currentLine);
				currentLine = "  " + word;
			} else {
				currentLine += (currentLine.trim() ? " " : "") + word;
			}
		}
		if (currentLine.trim()) lines.push(currentLine);
	} else {
		lines.push(`description: "${skillDescription.replace(/"/g, '\\"')}"`);
	}
	lines.push("---");
	lines.push("");

	// ── Commands reference ──
	if (registrations.commands.length > 0) {
		lines.push("<commands_reference>");
		for (const cmd of registrations.commands) {
			lines.push(`<command name="/${cmd.name}">`);
			lines.push(cmd.description);
			lines.push(`</command>`);
			lines.push("");
		}
		lines.push("</commands_reference>");
		lines.push("");
	}

	// ── Hooks ──
	if (registrations.events.length > 0) {
		const uniqueEvents = [...new Set(registrations.events.map((e) => e.event))];
		lines.push("<hooks>");
		for (const event of uniqueEvents) {
			lines.push(`- \`${event}\``);
		}
		lines.push("</hooks>");
		lines.push("");
	}

	// ── Event bus listeners ──
	if (registrations.eventBus.length > 0) {
		const uniqueChannels = [...new Set(registrations.eventBus.map((e) => e.channel))];
		lines.push("<event_bus>");
		lines.push(`Listens on: ${uniqueChannels.map((c) => `\`${c}\``).join(", ")}`);
		lines.push("</event_bus>");
		lines.push("");
	}

	// ── Bundled resources ──
	if (specs.length > 0) {
		lines.push("<bundled_resources>");
		lines.push(`${specs.length} seed specs bundled: ${specs.map((s) => `\`${s.name}\``).join(", ")}.`);
		lines.push("See references/bundled-resources.md for full inventory.");
		lines.push("See references/spec-vocabulary.md for extract and reassembly vocabulary.");
		lines.push("</bundled_resources>");
		lines.push("");
	}

	// ── Compaction vocabulary (inline summary) ──
	lines.push("<compaction_vocabulary>");
	lines.push("");
	lines.push("**Strategies:** `mechanical` (regex/tool-call inspection, no LLM cost), `llm` (model-driven structured extraction)");
	lines.push("");
	lines.push("**Priorities:** `critical` > `high` > `normal` (default) > `low`");
	lines.push("");
	lines.push("**Overflow:** `trim-lowest` (default, drops lowest-priority artifacts), `truncate-all` (proportionally shrinks non-critical)");
	lines.push("");

	if (specs.length > 0) {
		lines.push("**Seed specs:**");
		lines.push("");
		lines.push("| Spec | Extracts | Budget | Overflow |");
		lines.push("|------|----------|--------|----------|");
		for (const spec of specs) {
			const extractNames = spec.extracts.map((e) => e.name).join(", ");
			const budget = spec.budget != null ? String(spec.budget) : "none";
			const overflow = spec.overflow || "trim-lowest";
			lines.push(`| \`${spec.name}\` | ${extractNames} | ${budget} | ${overflow} |`);
		}
		lines.push("");
	}

	lines.push("</compaction_vocabulary>");
	lines.push("");

	// ── Narrative body ──
	if (narrativeBody) {
		lines.push(narrativeBody);
		lines.push("");
	}

	// ── Footer ──
	lines.push("*Generated from source by `scripts/generate-skills.ts` — do not edit by hand.*");
	lines.push("");

	return lines.join("\n");
}

// ── Reference file: bundled resources ───────────────────────────────────────

function writeBundledResources(skillDir: string, specs: ParsedSpec[]): void {
	if (specs.length === 0) return;

	const refDir = join(skillDir, "references");
	mkdirSync(refDir, { recursive: true });

	const lines: string[] = [];
	lines.push("# Bundled Resources");
	lines.push("");
	lines.push(`## seeds/ (${specs.length} files)`);
	lines.push("");

	for (const spec of specs) {
		const extractSummary = spec.extracts.map((e) => e.name).join(", ");
		const budget = spec.budget != null ? `budget: ${spec.budget}` : "no budget";
		lines.push(`- \`seeds/${spec.fileName}\` — ${spec.extracts.length} extracts (${extractSummary}), ${budget}`);
	}
	lines.push("");

	writeFileSync(join(refDir, "bundled-resources.md"), lines.join("\n"));
}

// ── Reference file: spec vocabulary ─────────────────────────────────────────

function writeSpecVocabulary(skillDir: string, specs: ParsedSpec[]): void {
	if (specs.length === 0) return;

	const refDir = join(skillDir, "references");
	mkdirSync(refDir, { recursive: true });

	const lines: string[] = [];
	lines.push("# Spec Vocabulary");
	lines.push("");
	lines.push("Extracted from seed specs. Defines the vocabulary of extract names, strategies, priorities, formats, and reassembly configurations available out of the box.");
	lines.push("");

	// ── Type enums ──
	lines.push("## Type Enums");
	lines.push("");
	lines.push("| Type | Values |");
	lines.push("|------|--------|");
	lines.push("| Priority | `critical`, `high`, `normal` (default), `low` |");
	lines.push("| Strategy | `mechanical`, `llm` |");
	lines.push("| OverflowStrategy | `trim-lowest` (default), `truncate-all` |");
	lines.push("");

	// ── Per-spec extract catalogs ──
	for (const spec of specs) {
		lines.push(`## ${spec.name}`);
		lines.push("");

		if (spec.budget != null || spec.overflow) {
			const parts: string[] = [];
			if (spec.budget != null) parts.push(`Budget: ${spec.budget}`);
			parts.push(`Overflow: ${spec.overflow || "trim-lowest"}`);
			lines.push(parts.join(" | "));
			lines.push("");
		}

		lines.push("### Extracts");
		lines.push("");
		lines.push("| Name | Strategy | Priority | Caps | Description |");
		lines.push("|------|----------|----------|------|-------------|");
		for (const e of spec.extracts) {
			const priority = e.priority || "normal";
			const caps: string[] = [];
			if (e.maxTokens != null) caps.push(`maxTokens: ${e.maxTokens}`);
			if (e.maxEntries != null) caps.push(`maxEntries: ${e.maxEntries}`);
			const capsStr = caps.length > 0 ? caps.join(", ") : "none";
			lines.push(`| \`${e.name}\` | ${e.strategy} | ${priority} | ${capsStr} | ${e.description} |`);
		}
		lines.push("");

		// Format schemas
		lines.push("### Format Schemas");
		lines.push("");
		for (const e of spec.extracts) {
			lines.push(`**${e.name}:**`);
			lines.push("```");
			lines.push(e.format.trim());
			lines.push("```");
			lines.push("");
		}

		// Reassembly sources
		if (spec.sources.length > 0) {
			lines.push("### Reassembly Sources");
			lines.push("");
			lines.push("| Source | Label | Wrap Tag |");
			lines.push("|--------|-------|----------|");
			for (const src of spec.sources) {
				lines.push(`| \`${src.source}\` | ${src.as} | \`<${src.wrap}>\` |`);
			}
			lines.push("");
		}
	}

	writeFileSync(join(refDir, "spec-vocabulary.md"), lines.join("\n"));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.log("=== Generating SKILL.md for pi-custom-compactor ===");

	// 1. Import extension and capture registrations
	const { mockPi, registrations } = createMockPi();

	try {
		const entryPoint = join(ROOT, "src", "index.ts");
		const mod = await import(entryPoint);
		const factory = mod.default || mod;
		if (typeof factory === "function") {
			factory(mockPi);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  Warning: extension factory threw (may be expected): ${msg}`);
	}

	console.log(`  Commands: ${registrations.commands.length}`);
	console.log(`  Hooks: ${registrations.events.length}`);
	console.log(`  Event bus: ${registrations.eventBus.length}`);

	// 2. Parse seed specs
	const specs = parseSeedSpecs();
	console.log(`  Seed specs: ${specs.length}`);

	// 3. Read narrative
	const narrativePath = join(ROOT, "skill-narrative.md");
	const narrativeRaw = existsSync(narrativePath) ? readFileSync(narrativePath, "utf-8") : null;
	if (narrativeRaw) console.log(`  Narrative: found`);

	// 4. Read package.json description
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
	const packageDescription = pkg.description || "";

	// 5. Compose SKILL.md
	const content = composeSkill(registrations, specs, narrativeRaw, packageDescription);

	const skillDir = join(ROOT, "skills", SKILL_NAME);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, content);
	console.log(`  Wrote ${skillPath}`);

	// 6. Write reference files
	writeBundledResources(skillDir, specs);
	console.log(`  Wrote references/bundled-resources.md`);

	writeSpecVocabulary(skillDir, specs);
	console.log(`  Wrote references/spec-vocabulary.md`);

	// 7. Word count
	const wordCount = content.split(/\s+/).filter(Boolean).length;
	console.log(`  SKILL.md word count: ${wordCount}`);

	console.log("\n=== Done ===");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
