import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.ts';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	{
		ignores: [
			'docs/**',
			'dist/**',
			'build/**',
			'storybook-static/**',
			'coverage/**',
			'.svelte-kit/**'
		]
	},
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			"no-undef": 'off',
			// Allow underscore-prefixed destructured vars (e.g., form: _form for unused props)
			"@typescript-eslint/no-unused-vars": ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			// Allow standard SvelteKit navigation without resolve() - these are valid in SvelteKit
			"svelte/no-navigation-without-resolve": 'off',
			// Warn when source files exceed 750 lines (tsserver/monaco performance limits)
			"max-lines": ["warn", { max: 750, skipBlankLines: true, skipComments: true }]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	}
);
