export function textBetweenMarkers(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`missing section between ${startMarker} and ${endMarker}`)
  }
  return text.slice(start, end)
}
