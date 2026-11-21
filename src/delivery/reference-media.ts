/**
 * Reference media — anchor the vision critique to a concrete quality bar (U-B).
 *
 * An operator supplies a REFERENCE TARGET: a directory of images, a single
 * image, or a video of a comparable flagship build. The vision judge then
 * scores the artifact AGAINST that bar (ambition and craft), instead of
 * grading in a vacuum — a literal executor can pass a spec-complete review
 * while missing an entire layer the reference makes obvious.
 *
 * Extraction is fail-soft by contract: any missing tool (ffmpeg/ffprobe),
 * unreadable input, or extraction error returns a note explaining what
 * happened rather than throwing. Nothing here knows about any project,
 * model, or domain — video frames are sampled evenly across the duration.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.gif']);
const MAX_FRAMES = 4;

export interface ReferenceImages {
  /** Extracted reference image paths (PNG after video sampling; original files for image inputs). */
  images: string[];
  /** Human-readable provenance for logs/evidence (also surfaces extraction failures). */
  note: string;
}

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function runTool(
  tool: string,
  args: string[],
  timeoutMs = 30000
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const stdout = execFileSync(tool, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function probeDurationSeconds(videoPath: string): number | null {
  const res = runTool('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  if (!res.ok) return null;
  const dur = Number.parseFloat(res.stdout.trim());
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

function sampleVideoFrames(videoPath: string, outDir: string, maxFrames: number): ReferenceImages | null {
  const dur = probeDurationSeconds(videoPath);
  if (dur === null) {
    return { images: [], note: 'reference video duration unavailable (ffprobe failed or reported none)' };
  }
  mkdirSync(outDir, { recursive: true });
  const images: string[] = [];
  // Even sampling across the duration, offset to the middle of each slice so
  // intros/fades are less likely to dominate the reference bar.
  for (let i = 0; i < maxFrames; i++) {
    const t = Math.min(dur - 0.05, ((i + 0.5) / maxFrames) * dur);
    const out = join(outDir, `ref-${i + 1}.png`);
    const seek = Math.max(0, t);
    const res = runTool(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-ss', seek.toFixed(3), '-i', videoPath, '-frames:v', '1', out],
      60000
    );
    if (res.ok && existsSync(out)) images.push(out);
  }
  if (images.length === 0) {
    return { images: [], note: 'reference video yielded no frames (ffmpeg extraction failed)' };
  }
  return { images, note: `${images.length} frame(s) sampled evenly across ${dur.toFixed(1)}s of reference video` };
}

/**
 * Extract reference images from a directory, image, or video. Never throws.
 * The outDir is used only for video frame sampling (created on demand).
 */
export async function extractReferenceImages(
  inputPath: string,
  outDir: string,
  maxFrames: number = MAX_FRAMES
): Promise<ReferenceImages> {
  try {
    if (!existsSync(inputPath)) {
      return { images: [], note: `reference path not found: ${inputPath}` };
    }
    const cap = Math.max(1, Math.min(4, maxFrames));
    const st = statSync(inputPath);
    if (st.isDirectory()) {
      const files = readdirSync(inputPath)
        .filter((f) => IMAGE_EXTS.has(ext(f)))
        .sort()
        .slice(0, cap)
        .map((f) => join(inputPath, f));
      if (files.length === 0) {
        return { images: [], note: `reference directory has no images (.png/.jpg/.jpeg/.webp): ${inputPath}` };
      }
      return { images: files, note: `${files.length} reference image(s) from directory` };
    }
    const e = ext(inputPath);
    if (IMAGE_EXTS.has(e)) {
      return { images: [inputPath], note: '1 reference image' };
    }
    if (VIDEO_EXTS.has(e)) {
      const sampled = sampleVideoFrames(inputPath, outDir, cap);
      return sampled ?? { images: [], note: 'reference video sampling failed' };
    }
    return { images: [], note: `unsupported reference input (use an image, an image directory, or a video): ${e || 'no extension'}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { images: [], note: `reference extraction failed: ${msg}` };
  }
}

/** Build a data URL for an image file, picking the mime from the extension. */
export function imageDataUrl(path: string): string {
  const e = ext(path);
  const mime = e === '.jpg' || e === '.jpeg' ? 'image/jpeg' : e === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}
