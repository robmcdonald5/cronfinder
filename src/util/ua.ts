// The default Workers fetch User-Agent gets 403'd by Workday, Phenom, iCIMS.
// Always set one of these explicitly on every outbound request.

export const UA_GENERIC =
  "Mozilla/5.0 (compatible; cronfinder/1.0; +https://github.com/cronfinder)";

// For Workday and other tenants that reject non-browser UAs.
export const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
