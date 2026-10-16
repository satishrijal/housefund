'use strict';
/**
 * ocr.js — free on-server receipt OCR via tesseract.js (no API key).
 * Lazy-loaded so the server boots fine without it; jobs run one at a time.
 */
let Tesseract = null;
let missing = false;

function getT() {
  if (missing) return null;
  if (!Tesseract) {
    try { Tesseract = require('tesseract.js'); }
    catch (e) {
      missing = true;
      console.warn('[ocr] tesseract.js not available:', e.message);
      return null;
    }
  }
  return Tesseract;
}

let chain = Promise.resolve();
function scanImage(buffer) {
  const job = chain.then(() => run(buffer));
  chain = job.catch(() => {});
  return job;
}

async function run(buffer) {
  const T = getT();
  if (!T) return '';
  try {
    const worker = await T.createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer);
      return (data && data.text) || '';
    } finally {
      await worker.terminate();
    }
  } catch (e) {
    console.warn('[ocr] recognition failed:', e.message);
    return '';
  }
}

function available() { return getT() !== null; }

module.exports = { scanImage, available };
