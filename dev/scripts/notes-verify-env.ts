// Throwaway paths for notes-verify.ts, set BEFORE anything imports config.
//
// This is its own module for one reason: `src/config.ts` reads process.env at
// module load, so the variables have to be set before that module is pulled
// in. A side-effect import at the top of the script guarantees the order,
// which assignments in the script body would not — tsc hoists imports above
// statements, so the config module would already have read the environment.
//
// dotenv does not override a variable that is already set, so these win over
// whatever is in .env.
import fs from "fs"
import os from "os"
import path from "path"

export const RUN_DIR = path.join(os.tmpdir(), "ixa-notes-verify")
export const VAULT = path.join(RUN_DIR, "vault")
export const DB = path.join(RUN_DIR, "verify.db")
export const COLLECTION = "notes_verify"

fs.mkdirSync(RUN_DIR, { recursive: true })
process.env.IXA_DB_PATH = DB
process.env.OBSIDIAN_VAULT_PATH = VAULT
process.env.IXA_NOTES_COLLECTION = COLLECTION
