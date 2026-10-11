import { config } from "../config"
import { registry } from "./registry"
import { timeTool } from "./time"
import { dateTool } from "./date"
import { echoTool } from "./echo"
import { searchTool } from "./search"
import { shellReadTool } from "./shell-read"
import { shellWriteTool } from "./shell-write"
import { notifyTool } from "./notify"
import {
  rememberPreferenceTool,
  forgetPreferenceTool,
  listPreferencesTool,
} from "./preferences"
import { searchMemoryTool } from "./search-memory"
import { saveNoteTool, searchNotesTool } from "./notes"
import { startNewConversationTool } from "./conversation"

registry.register(timeTool)
registry.register(dateTool)
// NOT registered by default. `echo`'s description ("Echoes back the provided
// message. Useful for testing.") reads like a way to deliver a reply, and in
// live use on the desktop client the model called it to say something
// conversational — which tripped the confirmation gate for a plain sentence,
// and then the client's blocking stdin prompt froze its event loop.
//
// It stays available behind IXA_DEV_TOOLS=1 because it is the only tool that
// requires confirmation and is safe to trigger casually: with it off,
// exercising the gate by hand means using `shell_write`, which has real side
// effects. Every description the model reads costs tokens on every call too —
// this one was 253 chars / ~63 tok of the schema set.
if (config.dev.tools) registry.register(echoTool)
registry.register(searchTool)
registry.register(shellReadTool)
registry.register(shellWriteTool)
registry.register(notifyTool)
registry.register(rememberPreferenceTool)
registry.register(forgetPreferenceTool)
registry.register(listPreferencesTool)
registry.register(searchMemoryTool)
registry.register(saveNoteTool)
registry.register(searchNotesTool)
registry.register(startNewConversationTool)
