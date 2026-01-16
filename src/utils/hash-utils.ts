/**
 * Hash computation utilities
 * Using SHA256 for compatibility with Yandex Disk API
 */

/**
 * Compute SHA256 hash from ArrayBuffer
 * Using built-in Web Crypto API
 */
export async function computeSha256(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return arrayBufferToHex(hashBuffer);
}

/**
 * Compute SHA256 hash from string
 */
export async function computeSha256FromString(str: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(str);
	return computeSha256(data.buffer);
}

/**
 * Convert ArrayBuffer to hex string
 */
function arrayBufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
