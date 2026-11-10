// Throwaway paths for note-duplicate-verify.ts, set BEFORE anything imports
// config. Its own module and its own names, for the reason notes-verify-env.ts
// gives (config reads process.env at load) and one more: notes-verify.ts uses
// a fixed directory and collection, so two scripts sharing them would delete
// each other's vault mid-run.
import fs from "fs"
import os from "os"
import path from "path"

export const RUN_DIR = path.join(os.tmpdir(), "ixa-note-duplicate-verify")
export const COLLECTION = "notes_duplicate_verify"

fs.mkdirSync(RUN_DIR, { recursive: true })
process.env.IXA_DB_PATH = path.join(RUN_DIR, "base.db")
process.env.OBSIDIAN_VAULT_PATH = path.join(RUN_DIR, "base-vault")
process.env.IXA_NOTES_COLLECTION = COLLECTION
