import type { StaticCommand } from "./types.js"
import { siteIdContext } from "../ctx.js"

export const fetchingSiteId: StaticCommand = {
  name: 'get-site-id',
  commandText: siteIdContext
}
