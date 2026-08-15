import { registry } from "./registry"
import { timeTool } from "./time"
import { dateTool } from "./date"
import { echoTool } from "./echo"
import { searchTool } from "./search"
import { shellReadTool } from "./shell-read"
import { shellWriteTool } from "./shell-write"

registry.register(timeTool)
registry.register(dateTool)
registry.register(echoTool)
registry.register(searchTool)
registry.register(shellReadTool)
registry.register(shellWriteTool)
