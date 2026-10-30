#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('.')
  .filter(f => f.startsWith('starjump-') && f.endsWith('.json'));

if (files.length === 0) {
  console.log('No starjump-*.json files found in current directory');
  process.exit(1);
}

console.log(`Found ${files.length} fleet files to merge`);

let merged = null;
let allItems = [];
let currentOffsetX = 0;
const spacing = 14000; // breathing room between fleets

// For zoom approximation
let localCs = [];
let overallMinX = Infinity, overallMaxX = -Infinity;
let overallMinY = Infinity, overallMaxY = -Infinity;

// ────────────────────────────────────────────────
// PASS 1: Find global maximum text width for normalization
// ────────────────────────────────────────────────
const textGroupWidths = [];

files.forEach(file => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.canvasItems.forEach(item => {
    if (item.itemType === 'TEXTGROUP') {
      textGroupWidths.push(parseFloat(item.width));
    }
  });
});

const globalMaxWidth = Math.max(...textGroupWidths, 6000); // sensible fallback
console.log(`Global max label width used for scaling: ${globalMaxWidth.toFixed(1)}`);


// ────────────────────────────────────────────────
// PASS 2: Merge + normalize labels + offset
// ────────────────────────────────────────────────
files.forEach(file => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!merged) {
    merged = { ...data, canvasItems: [] };
  }

  let localMinX = Infinity, localMaxX = -Infinity;

  data.canvasItems.forEach(item => {
    const x = parseFloat(item.x);
    const y = parseFloat(item.y);
    localMinX = Math.min(localMinX, x);
    localMaxX = Math.max(localMaxX, x);
  });

  const localWidth = localMaxX - localMinX || 1000;
  const localC = parseFloat(data.canvasZoom || 0.03) * localWidth;
  localCs.push(localC);

  data.canvasItems.forEach(item => {
    const newItem = JSON.parse(JSON.stringify(item)); // deep copy

    // Horizontal offset for this fleet
    newItem.x = (parseFloat(item.x) + currentOffsetX).toFixed(10);
    newItem.y = parseFloat(item.y).toFixed(10);

    // ── Normalize TEXTGROUP ───────────────────────────────
    if (newItem.itemType === 'TEXTGROUP') {
      const origW = parseFloat(newItem.width);

      // Force consistent font size across all labels
      newItem.fontRes = 'm';           // ← most common readable size
      // newItem.fontFamily = 'Font1'; // already consistent in your files

      // Scale down oversized labels
      if (origW > globalMaxWidth * 1.08) {
        const scale = globalMaxWidth / origW;
        newItem.width  = (origW * scale).toFixed(4);
        newItem.height = (parseFloat(newItem.height) * scale).toFixed(4);
      }
      // Optional: slight upscale for very tiny labels (uncomment if needed)
      // else if (origW < globalMaxWidth * 0.4) {
      //   const scale = (globalMaxWidth * 0.7) / origW;
      //   newItem.width  = (origW * scale).toFixed(4);
      //   newItem.height = (parseFloat(newItem.height) * scale).toFixed(4);
      // }
    }

    allItems.push(newItem);

    const nx = parseFloat(newItem.x);
    const ny = parseFloat(newItem.y);
    overallMinX = Math.min(overallMinX, nx);
    overallMaxX = Math.max(overallMaxX, nx);
    overallMinY = Math.min(overallMinY, ny);
    overallMaxY = Math.max(overallMaxY, ny);
  });

  currentOffsetX += localWidth + spacing;
});

// ────────────────────────────────────────────────
// Center around (0,0)
// ────────────────────────────────────────────────
const centerX = (overallMinX + overallMaxX) / 2;
const centerY = (overallMinY + overallMaxY) / 2;

allItems.forEach(item => {
  item.x = (parseFloat(item.x) - centerX).toFixed(10);
  item.y = (parseFloat(item.y) - centerY).toFixed(10);
});

merged.canvasItems = allItems;
merged.canvasPanX = "0.0000000000";
merged.canvasPanY = "0.0000000000";

// Approximate zoom that feels similar to originals
const avgC = localCs.reduce((a, b) => a + b, 0) / localCs.length || 300;
const totalWidth = overallMaxX - overallMinX || 10000;
merged.canvasZoom = (avgC / totalWidth).toFixed(10);

const outputFile = 'starjump-merged-consistent-labels.json';
fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2));

console.log(`\nDone. Created: ${outputFile}`);
console.log(`Total items: ${allItems.length}`);
console.log(`Final zoom:  ${merged.canvasZoom}`);
console.log(`Label font:  m (forced consistent)`);
