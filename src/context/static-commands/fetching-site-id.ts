import type { StaticCommand } from "./types.js"
import { siteIdContext } from "../ctx.js"

export const fetchingSiteId: StaticCommand = {
  operationId: 'get-site-id',
  commandText: siteIdContext
}
