import { extractDocumentText, processTranscriptText } from "../ca-data-prep/process.js";

let writeFileAtPath;

export function createPlugin(deps) {
  ({ writeFileAtPath } = deps);
  return plugin;
}

export function deriveSpeakerGroup(speakerText) {
  const cleaned = String(speakerText || "").trim();
  if (!cleaned) return "";

  const withoutCode = cleaned.replace(/\s*#\S+\s*$/, "").trim();
  const match = withoutCode.match(/^(.*?)(?:\s*\(([^()]+)\))\s*$/);
  if (!match) return "";

  return match[2]?.trim() || "";
}

export function formatChatParticipants(speakerMap, defaultRole = "Participant") {
  const entries = [];

  for (const [speakerID, details] of speakerMap.entries()) {
    const speakerCode = String(speakerID).trim();
    const role = details.role || defaultRole;
    entries.push(`${speakerCode} ${role}`);
  }

  return `@Participants: ${entries.join(", ")}`;
}

export function formatChatIdLine(languageIso, corpusId, speakerCode, extra = {}) {
  const fields = [
    languageIso || "",
    corpusId || "",
    speakerCode || "",
    extra.age || "",
    extra.sex || "",
    extra.group || "",
    extra.ethnicity || "",
    extra.role || "",
    extra.education || "",
    extra.custom || "",
  ];

  return `@ID: ${fields.join("|")}|`;
}

export function generateChatText(text, config = {}) {
  const result = processTranscriptText(text, {
    headerRows: config.headerRows ?? 0,
    footerRows: config.footerRows ?? 0,
  });

  const speakerCodeByResolved = new Map();
  const participantEntries = [];

  for (const [speakerID, details] of result.speakerMap.entries()) {
    const resolvedSpeakerCode = String(details.optionalCode || speakerID).replace(/^#/, "");
    speakerCodeByResolved.set(String(details.optionalCode || speakerID), String(speakerID));
    const speakerCode = String(speakerID).trim();
    const role = details.role || "Participant";
    const group = (details.affiliation || deriveSpeakerGroup(details.name || details.label || speakerID)).replace(/^\((.*)\)$/, "$1");
    participantEntries.push({ speakerCode, role, group, resolvedSpeakerCode });
  }

  const languageIso = String(config.languageIso || "").trim();
  const corpusId = String(config.corpusId || "").trim();
  const lines = [formatChatParticipants(result.speakerMap)];

  for (const speaker of participantEntries) {
    lines.push(formatChatIdLine(languageIso, corpusId, speaker.speakerCode, {
      group: speaker.group,
      role: speaker.role,
    }));
  }

  lines.push("@Begin");
  for (const row of result.rows) {
    const resolvedCode = speakerCodeByResolved.get(String(row.speakerID)) || String(row.speakerID).replace(/^#/, "");
    const cleanedText = String(row.text || "").replace(/\s+/g, " ").trim();
    if (!cleanedText) continue;
    lines.push(`*${resolvedCode}: ${cleanedText}`);
  }
  lines.push("@End");

  return `${lines.join("\n")}\n`;
}

const plugin = {
  name: "chat-export",
  generateChatText,
  outputPaths: [{ path: "c2c-output/chat", kind: "dir" }],
  optionSchema: {
    key: "generateChatFiles",
    label: "Generate CHAT (.cha) outputs",
    default: false,
    hint: "Creates one CHAT transcript per .docx file, using the transcript speaker metadata and any parenthetical group name from the source.",
  },
  hooks: {
    "files:analyze": async (ctx) => {
      if (!ctx.options.generateChatFiles) return;
      const files = (ctx.filesWithMeta || ctx.files || []).filter((entry) => /\.docx$/i.test(entry.fileName || entry.name || ""));
      if (!files.length) return;

      const documentRecords = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const filePath = file.relativePath || file.fileName || file.name || "";
        ctx.log(`CHAT export: ${index + 1}/${files.length} file(s)…`, "muted");
        let buffer = file.arrayBuffer ? await file.arrayBuffer() : null;
        if (!buffer && ctx.dirHandle && filePath) {
          const { readDocxFileBytesFromDirHandle } = await import("../ca-data-prep/index.js");
          buffer = await readDocxFileBytesFromDirHandle(ctx.dirHandle, filePath);
        }
        if (!buffer) continue;

        const text = await extractDocumentText(buffer);
        const baseName = (file.fileName || file.name || "document").replace(/\.docx$/i, "");
        const chatText = generateChatText(text, {
          languageIso: ctx.options.languageIso || "",
          corpusId: ctx.dirHandle && ctx.dirHandle.name ? ctx.dirHandle.name : baseName,
          headerRows: ctx.options.headerRows || 0,
          footerRows: ctx.options.footerRows || 0,
        });

        documentRecords.push({
          baseName,
          docxName: file.fileName || file.name,
          chatDirName: "c2c-output/chat",
          sourcePath: filePath,
          chatText,
          chatName: `${baseName}.cha`,
        });
      }

      ctx.chatExport = { files, documentRecords };
      ctx.log(`Prepared CHAT export for ${documentRecords.length} .docx file(s).`, "muted");
    },

    "crate:built": async (ctx) => {
      if (!ctx.options.generateChatFiles || !ctx.chatExport) return;
      const { documentRecords } = ctx.chatExport;
      if (!documentRecords.length) return;

      const total = documentRecords.length;
      for (let i = 0; i < total; i++) {
        const doc = documentRecords[i];
        await writeFileAtPath(ctx.dirHandle, `${doc.chatDirName}/${doc.chatName}`, doc.chatText);
        ctx.log(`Writing CHAT export: ${i + 1}/${total} file(s)…`, "muted");
      }

      ctx.log(`Wrote ${documentRecords.length} CHAT file(s).`, "ok");
    },
  },
};
