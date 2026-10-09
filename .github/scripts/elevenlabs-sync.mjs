#!/usr/bin/env node
/*
  Syncs the Mintlify docs into the ElevenLabs knowledge base of the toernbot agent.

  - Pages come from docs.json navigation (both languages), so drafts and
    pages that are not in the navigation are never uploaded.
  - MDX is converted to plain Markdown (frontmatter → heading, components →
    text, images/iframes removed). Placeholder pages are skipped.
  - Every run uploads into a fresh folder "<ROOT_FOLDER> <run id>", points the
    agent to the new documents and only then deletes the previous folders.
    If anything fails before the agent update, the new folder is removed and
    the agent keeps working with the old documents.

  Usage:
    node .github/scripts/elevenlabs-sync.mjs --dry-run [--out <dir>]
    ELEVENLABS_API_KEY=… ELEVENLABS_AGENT_ID=… node .github/scripts/elevenlabs-sync.mjs [--prune-unmanaged]

  Env:
    ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID   required unless --dry-run
    ELEVENLABS_BASE_URL                        default https://api.elevenlabs.io
    KB_ROOT_FOLDER                             default "toern-docs"
    DOCS_BASE_URL                              optional, e.g. https://docs.re-toern.de – makes links absolute
    RUN_ID                                     optional suffix for the upload folder (defaults to a timestamp)
*/

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const PRUNE_UNMANAGED = args.includes("--prune-unmanaged");
const OUT_DIR = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

const API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_BASE = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
const ROOT_FOLDER = process.env.KB_ROOT_FOLDER || "toern-docs";
const DOCS_BASE_URL = (process.env.DOCS_BASE_URL || "").replace(/\/$/, "");
const RUN_ID =
  process.env.RUN_ID || new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);

const LABELS = {
  de: { Note: "Hinweis", Tip: "Tipp", Warning: "Achtung", Info: "Info", source: "Quelle", language: "Deutsch" },
  en: { Note: "Note", Tip: "Tip", Warning: "Warning", Info: "Info", source: "Source", language: "English" },
};

// ---------------------------------------------------------------------------
// Collect pages from docs.json
// ---------------------------------------------------------------------------

function collectPages() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "docs.json"), "utf8"));
  const pages = [];
  const seen = new Set();

  const walk = (node, lang, trail) => {
    if (typeof node === "string") {
      if (!seen.has(node)) {
        seen.add(node);
        pages.push({ page: node, lang, trail });
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    const label = node.tab || node.group;
    const nextTrail = label ? [...trail, label] : trail;
    for (const key of ["tabs", "groups", "pages"]) {
      if (Array.isArray(node[key])) node[key].forEach((child) => walk(child, lang, nextTrail));
    }
  };

  for (const language of config.navigation.languages) {
    walk(language, language.language, []);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// MDX → Markdown
// ---------------------------------------------------------------------------

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: source.slice(match[0].length) };
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|\\{["']([^"']*)["']\\})`));
  return m ? m[1] ?? m[2] ?? m[3] : null;
}

function absoluteUrl(href) {
  if (!href || !href.startsWith("/") || !DOCS_BASE_URL) return href;
  return DOCS_BASE_URL + href;
}

function isPlaceholder(body) {
  const text = body
    .replace(/<\/?Note>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^(Diese Seite ist in Arbeit\.|This page is a work in progress\.)$/.test(text);
}

function mdxToMarkdown(body, lang) {
  const labels = LABELS[lang] || LABELS.en;
  let md = body;

  // Imports/exports and comments
  md = md.replace(/^(import|export) .*$/gm, "");
  md = md.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  // Media: images, iframes, frames
  md = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  md = md.replace(/<img\b[^>]*\/?>/g, "");
  md = md.replace(/<iframe\b[\s\S]*?(\/>|<\/iframe>)/g, "");
  md = md.replace(/<\/?Frame\b[^>]*>/g, "");

  // Callouts → labelled paragraph
  md = md.replace(/<(Note|Tip|Warning|Info)\b[^>]*>/g, (_, type) => `\n**${labels[type]}:** `);
  md = md.replace(/<\/(Note|Tip|Warning|Info)>/g, "\n");

  // Cards → link list item (self-closing or with content)
  md = md.replace(/<Card\b([^>]*?)\/>/g, (tag) => cardLine(tag) + "\n");
  md = md.replace(/<Card\b[^>]*>/g, (tag) => cardLine(tag) + " ");
  md = md.replace(/<\/Card>/g, "\n");

  // Titled containers → headings
  md = md.replace(/<(Accordion|Tab|Step)\b[^>]*>/g, (tag) => {
    const title = attr(tag, "title");
    return title ? `\n#### ${title}\n` : "\n";
  });

  // Any remaining JSX tag
  md = md.replace(/<\/?[A-Z][A-Za-z]*\b[^>]*>/g, "");

  // Relative links → absolute
  md = md.replace(/\]\((\/[^)\s]*)\)/g, (_, href) => `](${absoluteUrl(href)})`);

  // Dedent component content outside code fences, keep nested list indentation
  let inFence = false;
  md = md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line.trimStart();
      }
      if (inFence) return line;
      if (/^\s+([-*]|\d+\.)\s/.test(line)) return line.replace(/^(\s*)/, (s) => " ".repeat(Math.max(0, s.length - 2)));
      return line.trim();
    })
    .join("\n");

  // Pull callout and card text up onto the label line
  md = md.replace(/^(\*\*[^*\n]+:\*\*|- \[[^\]\n]*\]\([^)\n]*\):|- \*\*[^*\n]*\*\*:) *\n+(?=[^\n#-])/gm, "$1 ");

  return md.replace(/\n{3,}/g, "\n\n").trim();

  function cardLine(tag) {
    const title = attr(tag, "title") || "";
    const href = attr(tag, "href");
    return href ? `- [${title}](${absoluteUrl(href)}):` : `- **${title}**:`;
  }
}

function buildDocuments() {
  const docs = [];
  const skipped = [];

  for (const { page, lang, trail } of collectPages()) {
    const file = [`${page}.mdx`, `${page}.md`].map((f) => path.join(ROOT, f)).find(fs.existsSync);
    if (!file) {
      skipped.push(`${page} (file not found)`);
      continue;
    }
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    if (isPlaceholder(body)) {
      skipped.push(`${page} (placeholder)`);
      continue;
    }

    const labels = LABELS[lang] || LABELS.en;
    const title = meta.title || page;
    const relPath = page.replace(/^en\//, "");
    const header = [
      `# ${title}`,
      meta.description || "",
      [
        `${labels.language} · ${trail.join(" › ")}`,
        DOCS_BASE_URL ? `${labels.source}: ${DOCS_BASE_URL}/${page.replace(/(^|\/)index$/, "")}` : "",
      ]
        .filter(Boolean)
        .join("  \n"),
    ]
      .filter(Boolean)
      .join("\n\n");

    docs.push({
      page,
      lang,
      folder: [lang, ...path.dirname(relPath).split("/").filter((p) => p !== ".")],
      fileName: `${path.basename(relPath)}.md`,
      name: `${title} (${lang}/${relPath})`,
      content: `${header}\n\n${mdxToMarkdown(body, lang)}\n`,
    });
  }
  return { docs, skipped };
}

// ---------------------------------------------------------------------------
// ElevenLabs API
// ---------------------------------------------------------------------------

async function api(method, endpoint, { json, form, query } = {}) {
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        "xi-api-key": API_KEY,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : form,
    });
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${method} ${endpoint} failed with HTTP ${res.status}: ${await res.text()}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listKnowledgeBase(query) {
  const items = [];
  let cursor;
  do {
    const page = await api("GET", "/v1/convai/knowledge-base", {
      query: { page_size: 100, cursor, ...query },
    });
    items.push(...(page.documents || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return items;
}

async function createFolder(name, parentId) {
  const res = await api("POST", "/v1/convai/knowledge-base/folder", {
    json: { name, ...(parentId ? { parent_folder_id: parentId } : {}) },
  });
  return res.id;
}

async function uploadDocument(doc, parentId) {
  const form = new FormData();
  form.append("file", new Blob([doc.content], { type: "text/markdown" }), doc.fileName);
  form.append("name", doc.name);
  form.append("parent_folder_id", parentId);
  const res = await api("POST", "/v1/convai/knowledge-base/file", { form });
  if (!res.id) throw new Error(`Upload of ${doc.page} returned no id`);
  return res.id;
}

async function deleteItem(id) {
  await api("DELETE", `/v1/convai/knowledge-base/${id}`, { query: { force: "true" } });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function sync(docs) {
  if (!API_KEY || !AGENT_ID) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required");

  const isManagedRoot = (item) =>
    item.type === "folder" && !item.folder_parent_id && item.name.startsWith(`${ROOT_FOLDER} `);

  const previousRoots = (await listKnowledgeBase({ types: "folder" })).filter(isManagedRoot);
  const previousDocIds = new Set();
  for (const folder of previousRoots) {
    for (const item of await listKnowledgeBase({ ancestor_folder_id: folder.id })) previousDocIds.add(item.id);
  }
  console.log(`Found ${previousRoots.length} previous upload folder(s) with ${previousDocIds.size} item(s)`);

  // 1. Upload everything into a fresh folder
  const rootName = `${ROOT_FOLDER} ${RUN_ID}`;
  const newRootId = await createFolder(rootName);
  console.log(`Created folder "${rootName}"`);

  let uploaded;
  try {
    const folderIds = new Map([["", newRootId]]);
    for (const doc of docs) {
      let key = "";
      for (const part of doc.folder) {
        const parentId = folderIds.get(key);
        key = key ? `${key}/${part}` : part;
        if (!folderIds.has(key)) folderIds.set(key, await createFolder(part, parentId));
      }
    }

    uploaded = await mapWithConcurrency(docs, 4, async (doc) => {
      const id = await uploadDocument(doc, folderIds.get(doc.folder.join("/")));
      console.log(`  ✅ ${doc.page} → ${id}`);
      return { type: "file", id, name: doc.name, usage_mode: "auto" };
    });
  } catch (error) {
    console.error(`❌ Upload failed, removing "${rootName}". The agent keeps its current knowledge base.`);
    await deleteItem(newRootId).catch((e) => console.error(`   Cleanup failed: ${e.message}`));
    throw error;
  }

  // 2. Point the agent to the new documents
  const agent = await api("GET", `/v1/convai/agents/${AGENT_ID}`);
  const current = agent.conversation_config?.agent?.prompt?.knowledge_base || [];
  const kept = PRUNE_UNMANAGED ? [] : current.filter((entry) => !previousDocIds.has(entry.id));
  if (kept.length) console.log(`Keeping ${kept.length} knowledge base entr(y/ies) not managed by this sync`);
  if (PRUNE_UNMANAGED && current.length) {
    const dropped = current.filter((entry) => !previousDocIds.has(entry.id));
    if (dropped.length) console.log(`Detaching ${dropped.length} unmanaged entr(y/ies): ${dropped.map((e) => e.name).join(", ")}`);
  }

  const knowledgeBase = [...kept, ...uploaded];
  await api("PATCH", `/v1/convai/agents/${AGENT_ID}`, {
    json: { conversation_config: { agent: { prompt: { knowledge_base: knowledgeBase } } } },
  });

  const verified = await api("GET", `/v1/convai/agents/${AGENT_ID}`);
  const attached = verified.conversation_config?.agent?.prompt?.knowledge_base?.length ?? 0;
  console.log(`Agent now has ${attached} knowledge base document(s) attached`);
  if (attached !== knowledgeBase.length) {
    console.warn(`⚠️  Expected ${knowledgeBase.length} attached documents`);
  }

  // 3. Remove previous uploads
  for (const folder of previousRoots) {
    await deleteItem(folder.id);
    console.log(`Deleted previous folder "${folder.name}"`);
  }
}

async function main() {
  const { docs, skipped } = buildDocuments();
  console.log(`Prepared ${docs.length} document(s), skipped ${skipped.length}`);
  skipped.forEach((s) => console.log(`  – ${s}`));

  if (OUT_DIR) {
    for (const doc of docs) {
      const target = path.join(OUT_DIR, ...doc.folder, doc.fileName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, doc.content);
    }
    console.log(`Wrote Markdown to ${OUT_DIR}`);
  }

  if (DRY_RUN) return;
  await sync(docs);
  console.log("✅ Sync complete");
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
