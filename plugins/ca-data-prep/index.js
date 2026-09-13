import {
  buildRoCrateMetadata,
  processTranscriptText,
  extractDocumentText,
  buildSpeakerPersonEntities,
  toCsv,
} from "./process.js";

// Hook names are literal strings and writeFileAtPath (fs_helpers.js) arrives
// via createPlugin(deps) — see this repo's README.
import { countedProgress } from "../../src/_progress.js";

let writeFileAtPath;

export function createPlugin(deps) {
  ({ writeFileAtPath } = deps);
  return plugin;
}

export function addCsvFilesToCrate(crate, documentRecords) {
  for (const doc of documentRecords) {
    const csvId = `${doc.csvDirName}/${doc.csvName}`;
    const objectId = `#${doc.baseName}`;
    const hasObject = crate.hasEntity(objectId);
    crate.addEntity({
      "@id": csvId,
      "@type": "File",
      name: doc.csvName,
      encodingFormat: "text/csv",
      ...(hasObject ? { isPartOf: { "@id": objectId } } : {}),
      ...(doc.docxId ? { annotationOf: { "@id": doc.docxId } } : {}),
    });

    if (hasObject) {
      const parts = crate.getProperty(objectId, "hasPart");
      const nextParts = Array.isArray(parts) ? parts : (parts ? [parts] : []);
      if (!nextParts.some((part) => part && part["@id"] === csvId)) nextParts.push({ "@id": csvId });
      crate.setProperty(objectId, "hasPart", nextParts);
      const mainText = crate.getProperty(objectId, "ldac:mainText");
      if (!mainText || (mainText["@id"] || mainText) !== csvId) crate.setProperty(objectId, "ldac:mainText", { "@id": csvId });
    }
  }
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
  outputPaths: [
    { path: "c2c-output/csv", kind: "dir" },
    { path: "c2c-output/logs", kind: "dir" },
  ],
  optionSchema: {
    key: "processTranscriptDocuments",
    label: "Process plain transcript documents (.docx)",
    default: false,
    hint: "Runs the CAAT/AmAus transcript parser over .docx files in the generic folder build, writing cleaned CSV/log outputs and transcript metadata.",
  },
  hooks: {
    "files:prepare": {
      priority: 30,
      weight: 5,
      activeWhen: (ctx) => !!ctx.options.processTranscriptDocuments,
      handler: async (ctx) => {
        if (!ctx.options.processTranscriptDocuments) return;
        const files = (ctx.filesWithMeta || ctx.files || []).filter((entry) => /\.docx$/i.test(entry.fileName || entry.name || ""));
        if (!files.length) return;

        const documentRecords = [];
        const tick = countedProgress(ctx, files.length, "Processing transcript documents…");
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const filePath = file.relativePath || file.fileName || file.name || "";
          let buffer = file.arrayBuffer ? await file.arrayBuffer() : null;
          if (!buffer && ctx.dirHandle && filePath) {
            buffer = await readDocxFileBytesFromDirHandle(ctx.dirHandle, filePath);
          }
          if (!buffer) {
            ctx.log(`Skipped transcript processing for ${filePath || file.fileName || file.name || "unknown .docx"}: file bytes were unavailable.`, "warn");
            // Skipped files still count towards the bar — otherwise a folder
            // where half the .docx files are unreadable leaves it short.
            tick(index);
            continue;
          }
          const text = await extractDocumentText(buffer);
          const result = await processTranscriptText(text, ctx.options || {});
          const baseName = (file.fileName || file.name).replace(/\.docx$/i, "");
          const csvText = toCsv(result.rows);
          const csvDirName = "c2c-output/csv";
          const logDirName = "c2c-output/logs";

          const speakerRefs = Array.from(result.speakerMap.entries()).map(([speakerID, details]) => ({
            "@id": details.optionalCode || `#${speakerID}`,
          }));

          documentRecords.push({
            baseName,
            docxName: file.fileName || file.name,
            csvName: `${baseName}.csv`,
            csvDirName,
            logDirName,
            sourcePath: file.relativePath,
            objectId: `#${baseName}`,
            docxId: file.relativePath,
            csvId: `${csvDirName}/${baseName}.csv`,
            annotationId: `#annotation-${baseName}`,
            speakerRefs,
            persons: buildSpeakerPersonEntities(result.speakerMap),
            csvText,
            logText: `${result.log}\n`,
            fileCount: 1,
          });
          tick(index, `Processed ${file.fileName || file.name}`);
        }

        tick.done();
        ctx.caDataPrep = { files, documentRecords };
        ctx.log(`Prepared transcript processing for ${files.length} .docx file(s).`, "muted");
      },
    },

    "crate:build": {
      priority: 50,
      weight: 2,
      activeWhen: (ctx) => !!ctx.options.processTranscriptDocuments,
      handler: async (ctx) => {
        if (!ctx.options.processTranscriptDocuments || !ctx.caDataPrep) return;
        const { files, documentRecords } = ctx.caDataPrep;
        if (!documentRecords.length) return;

        const writeTick = countedProgress(ctx, documentRecords.length, "Writing transcript CSV and log files…");
        for (let i = 0; i < documentRecords.length; i++) {
          const document = documentRecords[i];
          await writeFileAtPath(ctx.dirHandle, `${document.csvDirName}/${document.baseName}.csv`, document.csvText);
          await writeFileAtPath(ctx.dirHandle, `${document.logDirName}/${document.baseName}.log.txt`, document.logText);
          writeTick(i, `Wrote ${document.baseName}.csv`);
        }
        writeTick.done();

        // ctx.crate is about to be replaced wholesale below — read the selected
        // profile's own conformsTo (already assembled by processFolder into
        // ctx.config.rootDataset) before that happens, so the crate this
        // builds still reflects whichever profile the user actually picked
        // instead of silently reverting to buildRoCrateMetadata's own default.
        const selectedConformsTo = ctx.config?.rootDataset?.conformsTo?.["@id"];
        ctx.crate = buildRoCrateMetadata((ctx.dirHandle && ctx.dirHandle.name) || "Transcript Collection", documentRecords, selectedConformsTo);
        addCsvFilesToCrate(ctx.crate, documentRecords);
        ctx.sourceCount = files.length;
        ctx.log(`Built transcript crate from ${files.length} .docx file(s).`, "ok");
      },
    },
  },
};
