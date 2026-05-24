import { mkdir, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";

/**
 * Storage for user-uploaded cover images. Separate directory from the
 * music files so the two can have separate Docker volumes. One image
 * per track, named `<trackId>.<ext>`; re-uploading replaces it, and a
 * track's cover is removed when the track is deleted.
 */
const COVER_DIR = process.env.COVER_DIR || "/app/data/covers";

const ALLOWED_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const COVER_FILENAME_RE = /^[\w-]+\.(jpe?g|png|webp|gif)$/i;

export function getCoverDir(): string {
  return COVER_DIR;
}

export async function ensureCoverDir(): Promise<void> {
  await mkdir(COVER_DIR, { recursive: true });
}

/** Map an upload mimetype to a stored extension, or null if unsupported. */
export function extForMime(mime: string): string | null {
  return ALLOWED_EXT[mime.toLowerCase()] ?? null;
}

/** Content-Type to serve a stored cover filename with. */
export function mimeForCoverFile(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** True iff `name` is a single safe `<id>.<ext>` cover filename. */
export function isSafeCoverFilename(name: string): boolean {
  return (
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    COVER_FILENAME_RE.test(name)
  );
}

export function coverFilePath(filename: string): string {
  return join(COVER_DIR, filename);
}

/** Delete any cover file(s) for `trackId` (`<trackId>.*`). Best-effort. */
export async function deleteCoverFor(trackId: string): Promise<void> {
  try {
    const files = await readdir(COVER_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith(`${trackId}.`))
        .map((f) => unlink(join(COVER_DIR, f)).catch(() => undefined)),
    );
  } catch {
    // dir doesn't exist yet / unreadable — nothing to clean
  }
}

/**
 * Save `buffer` as the cover for `trackId` with extension `ext`,
 * replacing any previous cover. Returns the stored filename
 * (`<trackId>.<ext>`).
 */
export async function saveCover(
  trackId: string,
  buffer: Buffer,
  ext: string,
): Promise<string> {
  await ensureCoverDir();
  await deleteCoverFor(trackId);
  const filename = `${trackId}.${ext}`;
  await writeFile(join(COVER_DIR, filename), buffer);
  return filename;
}
