import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["package.json"],
		rules: {
			"depend/ban-dependencies": [
				"error",
				{
					presets: ["native", "microutilities", "preferred"],
					allowed: ["dotenv", "lint-staged"],
				},
			],
		},
	},
	{
		files: ["eslint.config.mts", "**/*.{js,mjs,cjs}"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
		},
	},
	{
		files: ["tests/**/*.ts", "test.config.mjs"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
			"@typescript-eslint/no-floating-promises": "off",
		},
	},
	{
		files: ["tests/helpers/**/*.ts"],
		rules: {
			// Synthetic vaults define configDir instead of reading a real vault.
			"obsidianmd/hardcoded-config-path": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"build",
		"versions.json",
		"main.js",
		".husky/_/**",
		".env*",
	]),
	prettier,
	{
		files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
		rules: {
			curly: ["error", "all"],
		},
	},
);
