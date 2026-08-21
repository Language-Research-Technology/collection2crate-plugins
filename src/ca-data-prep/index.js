import {
  buildRoCrateMetadata,
  processTranscriptText,
  extractDocumentText,
  buildSpeakerPersonEntities,
  toCsv,
} from "./process.js";

// Hook names are literal strings and writeFileAtPath (fs_helpers.js) arrives
// via createPlugin(deps) — see this repo's README.
let writeFileAtPath;

export function createPlugin(deps) {
  ({ writeFileAtPath } = deps);
  return plugin;
}

export async function readDocxFileBytesFromDirHandle(dirHandle, relativePath) {
  if (!dirHandle || !relativePath) return null;
  const parts = String(relativePath).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  let dir = dirHandle;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: false });
  return await (await fileHandle.getFile()).arrayBuffer();
}

const plugin = {
  name: "ca-data-prep",
  optionSchema: {
    key: "processTranscriptDocuments",
    label: "Process plain transcript documents (.docx)",
    default: false,
    hint: "Runs the CAAT/AmAus transcript parser over .docx files in the generic folder build, writing cleaned CSV/log outputs and transcript metadata.",
  },
  hooks: {
    "files:analyze": async (ctx) => {
      if (!ctx.options.processTranscriptDocuments) return;
      const files = (ctx.filesWithMeta || ctx.files || []).filter((entry) => /\.docx$/i.test(entry.fileName || entry.name || ""));
      if (!files.length) return;

      const documentRecords = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const filePath = file.relativePath || file.fileName || file.name || "";
        ctx.log(`Processing transcript document: ${index + 1}/${files.length} file(s)…`, "muted");
        let buffer = file.arrayBuffer ? await file.arrayBuffer() : null;
        if (!buffer && ctx.dirHandle && filePath) {
          buffer = await readDocxFileBytesFromDirHandle(ctx.dirHandle, filePath);
        }
        if (!buffer) {
          ctx.log(`Skipped transcript processing for ${filePath || file.fileName || file.name || "unknown .docx"}: file bytes were unavailable.`, "warn");
          continue;
        }
        const text = await extractDocumentText(buffer);
        const result = processTranscriptText(text, ctx.options || {});
        const baseName = (file.fileName || file.name).replace(/\.docx$/i, "");
        const csvText = toCsv(result.rows);
        const outputDirName = "c2c-output";

        const speakerRefs = Array.from(result.speakerMap.entries()).map(([speakerID, details]) => ({
          "@id": details.optionalCode || `#${speakerID}`,
        }));

        documentRecords.push({
          baseName,
          docxName: file.fileName || file.name,
          csvName: `${baseName}.csv`,
          outputDirName,
          sourcePath: file.relativePath,
          objectId: `./${outputDirName}/${baseName}`,
          docxId: file.relativePath,
          csvId: `./${outputDirName}/${baseName}.csv`,
          annotationId: `#annotation-${baseName}`,
          speakerRefs,
          persons: buildSpeakerPersonEntities(result.speakerMap),
          csvText,
          logText: `${result.log}\n`,
          fileCount: 1,
        });
      }

      ctx.caDataPrep = { files, documentRecords };
      ctx.log(`Prepared transcript processing for ${files.length} .docx file(s).`, "muted");
    },

    "crate:built": async (ctx) => {
      if (!ctx.options.processTranscriptDocuments || !ctx.caDataPrep) return;
      const { files, documentRecords } = ctx.caDataPrep;
      if (!documentRecords.length) return;

      for (const document of documentRecords) {
        await writeFileAtPath(ctx.dirHandle, `${document.outputDirName}/${document.baseName}.csv`, document.csvText);
        await writeFileAtPath(ctx.dirHandle, `${document.outputDirName}/${document.baseName}.log.txt`, document.logText);
      }

      ctx.crate = buildRoCrateMetadata((ctx.dirHandle && ctx.dirHandle.name) || "Transcript Collection", documentRecords);
      ctx.sourceCount = files.length;
      ctx.log(`Built transcript crate from ${files.length} .docx file(s).`, "ok");
    },
  },
};
