/**
 * Encryption service for E2E encryption of file content and filenames.
 *
 * Uses Web Crypto API exclusively for cross-platform compatibility (desktop + mobile).
 * - Content: AES-256-GCM with random 12-byte IV
 * - Filenames: AES-256-GCM with deterministic IV derived from SHA-256(path + salt)
 *
 * Format of encrypted content:
 *   [12-byte random IV][AES-GCM ciphertext + 16-byte auth tag]
 *
 * Format of encrypted filenames (Base64URL):
 *   Base64URL([12-byte deterministic IV][AES-GCM ciphertext + 16-byte tag])
 *   IV is stored prepended so decryption works without knowing the original path.
 */

const PBKDF2_ITERATIONS = 100_000;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

export class EncryptionService {
	private key: CryptoKey | null = null;
	private readonly salt: Uint8Array;

	constructor(salt: Uint8Array) {
		if (salt.length !== SALT_LENGTH) {
			throw new Error(`Salt must be ${SALT_LENGTH} bytes`);
		}
		this.salt = salt;
	}

	/**
	 * Derive AES-256-GCM key from password using PBKDF2 (100k iterations, HMAC-SHA256).
	 */
	async initializeKey(password: string): Promise<void> {
		const encoder = new TextEncoder();
		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			encoder.encode(password),
			"PBKDF2",
			false,
			["deriveKey"]
		);

		this.key = await crypto.subtle.deriveKey(
			{
				name: "PBKDF2",
				salt: this.salt,
				iterations: PBKDF2_ITERATIONS,
				hash: "SHA-256",
			},
			keyMaterial,
			{
				name: "AES-GCM",
				length: 256,
			},
			false,
			["encrypt", "decrypt"]
		);
	}

	/**
	 * Encrypt data with AES-256-GCM using a random IV.
	 * Returns: [12-byte IV][ciphertext + 16-byte auth tag]
	 */
	async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
		const encrypted = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			this.getKey(),
			data
		);

		const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
		result.set(iv, 0);
		result.set(new Uint8Array(encrypted), IV_LENGTH);
		return result.buffer;
	}

	/**
	 * Decrypt data encrypted with `encrypt()`.
	 * Expects: [12-byte IV][AES-GCM ciphertext + 16-byte auth tag]
	 */
	async decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		const bytes = new Uint8Array(data);
		const iv = bytes.slice(0, IV_LENGTH);
		const ciphertext = bytes.slice(IV_LENGTH);

		return await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			this.getKey(),
			ciphertext
		);
	}

	/**
	 * Deterministically encrypt a filename.
	 * IV = SHA-256(originalPath + ":iv:" + base64(salt)).slice(0, 12)
	 *
	 * Same input always produces the same output — required for
	 * finding remote files by plaintext path during sync.
	 *
	 * Returns Base64URL-encoded string (no padding, URL-safe).
	 */
	async encryptFilename(originalPath: string): Promise<string> {
		const encoder = new TextEncoder();
		const ivInput = encoder.encode(
			originalPath + ":iv:" + EncryptionService.bytesToBase64(this.salt)
		);
		const ivHash = await crypto.subtle.digest("SHA-256", ivInput);
		const iv = new Uint8Array(ivHash).slice(0, IV_LENGTH);

		const encrypted = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			this.getKey(),
			encoder.encode(originalPath)
		);

		const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
		combined.set(iv, 0);
		combined.set(new Uint8Array(encrypted), IV_LENGTH);

		return EncryptionService.base64UrlEncode(combined);
	}

	/**
	 * Decrypt a filename encrypted with `encryptFilename()`.
	 * Extracts the IV from the first 12 bytes of the decoded data.
	 */
	async decryptFilename(encryptedName: string): Promise<string> {
		const data = EncryptionService.base64UrlDecode(encryptedName);
		const iv = data.slice(0, IV_LENGTH);
		const ciphertext = data.slice(IV_LENGTH);

		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			this.getKey(),
			ciphertext
		);

		return new TextDecoder().decode(decrypted);
	}

	/**
	 * Generate cryptographically random salt for PBKDF2.
	 */
	static generateSalt(): Uint8Array {
		return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	}

	/**
	 * Check if the key is initialized (i.e., `initializeKey()` was called successfully).
	 */
	isKeyInitialized(): boolean {
		return this.key !== null;
	}

	/**
	 * Return the salt for serialization.
	 */
	getSalt(): Uint8Array {
		return this.salt;
	}

	// ============================================================================
	// Private helpers
	// ============================================================================

	private getKey(): CryptoKey {
		if (!this.key) {
			throw new Error("EncryptionService not initialized. Call initializeKey() first.");
		}
		return this.key;
	}

	// ============================================================================
	// Static encoding utilities
	// ============================================================================

	/**
	 * Encode bytes to Base64 string.
	 */
	static bytesToBase64(bytes: Uint8Array): string {
		let binary = "";
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]!);
		}
		return btoa(binary);
	}

	/**
	 * Decode Base64 string to bytes.
	 */
	static base64ToBytes(base64: string): Uint8Array {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	/**
	 * Encode bytes to Base64URL (no padding, URL-safe).
	 */
	static base64UrlEncode(bytes: Uint8Array): string {
		return EncryptionService.bytesToBase64(bytes)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	/**
	 * Decode Base64URL string to bytes.
	 */
	static base64UrlDecode(base64url: string): Uint8Array {
		let base64 = base64url
			.replace(/-/g, "+")
			.replace(/_/g, "/");
		while (base64.length % 4 !== 0) {
			base64 += "=";
		}
		return EncryptionService.base64ToBytes(base64);
	}
}
