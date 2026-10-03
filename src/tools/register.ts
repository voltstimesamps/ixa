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

registry.register(timeTool)
registry.register(dateTool)
registry.register(echoTool)
registry.register(searchTool)
registry.register(shellReadTool)
registry.register(shellWriteTool)
registry.register(notifyTool)
registry.register(rememberPreferenceTool)
registry.register(forgetPreferenceTool)
registry.register(listPreferencesTool)
registry.register(searchMemoryTool)
