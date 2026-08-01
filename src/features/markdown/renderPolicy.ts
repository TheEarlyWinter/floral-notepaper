export function canRenderRawHtml(isExternal: boolean, configured: boolean): boolean {
  return !isExternal && configured;
}
