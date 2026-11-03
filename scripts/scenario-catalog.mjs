const PRIORITIES = new Set(["P0", "P1", "P2"]);
const SCENARIO_ID = /^[A-Z]+(?:-[A-Z]+)*-\d+$/;

/** Parse user-scenario rows while ignoring invariant and Markdown header rows. */
export function parseScenarioRows(markdown) {
	return markdown.split("\n").flatMap((line, index) => {
		if (!line.startsWith("|")) {
			return [];
		}
		const cells = line.split("|").map((cell) => cell.trim());
		if (!SCENARIO_ID.test(cells[1] ?? "")) {
			return [];
		}
		if (!PRIORITIES.has(cells[2] ?? "")) {
			return [];
		}
		return [
			{
				id: cells[1],
				priority: cells[2],
				expected: cells[4] ?? "",
				evidence: cells.at(-2) ?? "",
				line: index + 1,
			},
		];
	});
}

/** Parse the strict auto/manual evidence grammar used by the catalogue. */
export function parseScenarioEvidence(value) {
	const autoNames = [];
	const manualCases = [];
	const invalidFragments = [];
	let manualRequired = false;
	let knownLimitation = false;
	const diagnostics = [];
	let readingAutoNames = false;

	for (const fragment of value.split(";").map((part) => part.trim())) {
		const firstAuto = fragment.match(/^auto:\s*(.+)$/);
		if (firstAuto) {
			const names = firstAuto[1].replace(/\s+\([^()`\r\n]+\)$/, "");
			const titles = [...names.matchAll(/`([^`]+)`/g)].map(
				(match) => match[1],
			);
			if (
				titles.length > 0 &&
				!names.replace(/`[^`]+`/g, "").replace(/[\s,]/g, "")
			) {
				autoNames.push(...titles);
				readingAutoNames = true;
			} else {
				invalidFragments.push(fragment);
				readingAutoNames = false;
			}
			continue;
		}
		const continuedAuto = fragment.match(/^`([^`]+)`$/);
		if (continuedAuto && readingAutoNames) {
			autoNames.push(continuedAuto[1]);
			continue;
		}
		readingAutoNames = false;
		if (/^manual-required(?:\s*:\s*.+|\s*\([^()]+\))?$/.test(fragment)) {
			manualRequired = true;
			continue;
		}
		const manual = fragment.match(
			/^manual:\s*`(TC-(?:[A-Z]+-)*\d+)`(?:\s*\([^()]+\))?$/,
		);
		if (manual) {
			manualCases.push(manual[1]);
			continue;
		}
		if (fragment === "known-limitation") {
			knownLimitation = true;
			continue;
		}
		const diagnostic = fragment.match(
			/^diagnostic:\s*(?:`([^`]+)`|(npm run test:force-fencing))$/,
		);
		if (diagnostic) {
			diagnostics.push(diagnostic[1] ?? diagnostic[2]);
			continue;
		}
		invalidFragments.push(fragment || "<empty>");
	}

	return {
		autoNames,
		manualCases,
		manualRequired,
		knownLimitation,
		diagnostics,
		invalidFragments,
	};
}

/** Collect literal, two-mode and statically declared table-driven test names. */
export function collectNodeTestNames(sources) {
	const names = new Set();
	const declaration = /\b(?:test|httpTest)\(\s*(["'`])([\s\S]*?)\1\s*,/g;
	for (const source of sources) {
		for (const match of source.matchAll(declaration)) {
			const name = match[2];
			if (!name.includes("${")) {
				names.add(name);
				continue;
			}
			if (
				name.includes("${mode}") &&
				!name.replace("${mode}", "").includes("${")
			) {
				names.add(name.replace("${mode}", "plaintext"));
				names.add(name.replace("${mode}", "encrypted"));
			}
		}
		const tree = ts.createSourceFile(
			"tests.ts",
			source,
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (node) => {
			if (
				ts.isCallExpression(node) &&
				node.expression.getText(tree) === "test"
			) {
				const title = node.arguments[0];
				if (title && ts.isTemplateExpression(title)) {
					let expanded = [title.head.text];
					let conditionalSpans = 0;
					for (const span of title.templateSpans) {
						const expression = span.expression;
						let choices = [];
						if (
							ts.isIdentifier(expression) &&
							expression.text === "mode"
						) {
							choices = ["plaintext", "encrypted"];
						} else if (
							ts.isConditionalExpression(expression) &&
							ts.isStringLiteral(expression.whenTrue) &&
							ts.isStringLiteral(expression.whenFalse)
						) {
							conditionalSpans++;
							if (conditionalSpans > 1) {
								expanded = [];
								break;
							}
							if (
								expression.condition.kind ===
								ts.SyntaxKind.TrueKeyword
							) {
								choices = [expression.whenTrue.text];
							} else if (
								expression.condition.kind ===
								ts.SyntaxKind.FalseKeyword
							) {
								choices = [expression.whenFalse.text];
							} else if (ts.isIdentifier(expression.condition)) {
								let loop = node.parent;
								while (loop && !ts.isForOfStatement(loop)) {
									loop = loop.parent;
								}
								const variable =
									loop?.initializer?.declarations?.[0]?.name;
								let values = loop?.expression;
								if (values && ts.isAsExpression(values)) {
									values = values.expression;
								}
								if (
									variable &&
									ts.isIdentifier(variable) &&
									variable.text ===
										expression.condition.text &&
									values &&
									ts.isArrayLiteralExpression(values) &&
									values.elements.length === 2 &&
									values.elements.some(
										(value) =>
											value.kind ===
											ts.SyntaxKind.TrueKeyword,
									) &&
									values.elements.some(
										(value) =>
											value.kind ===
											ts.SyntaxKind.FalseKeyword,
									)
								) {
									choices = [
										expression.whenTrue.text,
										expression.whenFalse.text,
									];
								}
							}
						}
						if (choices.length === 0) {
							expanded = [];
							break;
						}
						expanded = expanded.flatMap((prefix) =>
							choices.map(
								(choice) => prefix + choice + span.literal.text,
							),
						);
					}
					for (const name of expanded) {
						names.add(name);
					}
				}
				const bindingName =
					title && ts.isPropertyAccessExpression(title)
						? title.expression.getText(tree)
						: title?.getText(tree);
				let loop = node.parent;
				while (loop && !ts.isForOfStatement(loop)) {
					loop = loop.parent;
				}
				if (loop && ts.isVariableDeclarationList(loop.initializer)) {
					const binding = loop.initializer.declarations[0]?.name;
					let field;
					if (
						binding &&
						ts.isIdentifier(binding) &&
						binding.text === bindingName &&
						title &&
						ts.isPropertyAccessExpression(title)
					) {
						field = title.name.text;
					} else if (
						binding &&
						(ts.isObjectBindingPattern(binding) ||
							ts.isArrayBindingPattern(binding))
					) {
						const index = binding.elements.findIndex(
							(element) =>
								element.name?.getText(tree) === bindingName,
						);
						if (index >= 0) {
							field = ts.isArrayBindingPattern(binding)
								? index
								: (
										binding.elements[index].propertyName ??
										binding.elements[index].name
									).getText(tree);
						}
					}
					let values = loop.expression;
					if (ts.isIdentifier(values)) {
						const identifier = values.text;
						let scope = loop.parent;
						while (scope) {
							const declaration = scope.statements
								?.filter(ts.isVariableStatement)
								.flatMap((statement) => [
									...statement.declarationList.declarations,
								])
								.find(
									(candidate) =>
										candidate.name.getText(tree) ===
											identifier &&
										candidate.pos < loop.pos,
								);
							if (declaration) {
								values = declaration.initializer;
								break;
							}
							scope = scope.parent;
						}
					}
					if (values && ts.isAsExpression(values)) {
						values = values.expression;
					}
					if (
						field !== undefined &&
						values &&
						ts.isArrayLiteralExpression(values)
					) {
						for (const row of values.elements) {
							const value =
								ts.isArrayLiteralExpression(row) &&
								typeof field === "number"
									? row.elements[field]
									: ts.isObjectLiteralExpression(row)
										? row.properties.find(
												(property) =>
													property.name?.getText(
														tree,
													) === field,
											)?.initializer
										: undefined;
							if (value && ts.isStringLiteral(value)) {
								names.add(value.text);
							}
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	return names;
}

/** Collect smoke cases and the scenario IDs declared by each case. */
function collectManualCaseCoverage(markdown) {
	const headings = [
		...markdown.matchAll(/^## (TC-(?:[A-Z]+-)*\d+)(?=[.:\s—])/gm),
	];
	return new Map(
		headings.map((heading, index) => {
			const start = heading.index ?? 0;
			const end = headings[index + 1]?.index ?? markdown.length;
			const section = markdown.slice(start, end);
			const coverage = section.match(
				/^Покрывает:?[^\n]*(?:\n(?!\n)[^\n]*)*/m,
			)?.[0];
			const covered = new Set();
			for (const match of (coverage ?? "").matchAll(
				/`([A-Z]+(?:-[A-Z]+)*-\d+)`(?:\s*[–-]\s*`([A-Z]+(?:-[A-Z]+)*-\d+)`)?/g,
			)) {
				const first = match[1];
				const last = match[2];
				if (!last) {
					covered.add(first);
					continue;
				}
				const prefix = first.slice(0, first.lastIndexOf("-") + 1);
				const start = first.slice(prefix.length);
				const end = last.slice(prefix.length);
				if (
					!last.startsWith(prefix) ||
					start.length !== end.length ||
					Number(end) < Number(start) ||
					Number(end) - Number(start) > 100
				) {
					throw new Error(
						`Invalid manual scenario range: ${match[0]}`,
					);
				}
				for (let n = Number(start); n <= Number(end); n++) {
					covered.add(prefix + String(n).padStart(start.length, "0"));
				}
			}
			return [heading[1], covered];
		}),
	);
}

/** Validate scenario IDs and their exact automated and manual evidence. */
export function validateScenarioCatalog(
	markdown,
	testSources,
	smokeTests,
	diagnosticScripts = {},
) {
	const rows = parseScenarioRows(markdown);
	const testNames = collectNodeTestNames(testSources);
	const manualCoverage = collectManualCaseCoverage(smokeTests);
	const seen = new Set();
	const errors = [];
	const rowLines = markdown.split("\n");
	for (const [index, line] of rowLines.entries()) {
		const cells = line.split("|").map((cell) => cell.trim());
		if (
			line.startsWith("|") &&
			PRIORITIES.has(cells[2]) &&
			/^[A-Za-z][A-Za-z0-9-]*$/.test(cells[1] ?? "") &&
			!SCENARIO_ID.test(cells[1])
		) {
			errors.push(`line ${index + 1}: invalid scenario ID ${cells[1]}`);
		}
	}

	for (const row of rows) {
		if (seen.has(row.id)) {
			errors.push(`${row.id}: duplicate scenario ID`);
		}
		seen.add(row.id);
		const evidence = parseScenarioEvidence(row.evidence);
		for (const command of evidence.diagnostics) {
			const script = command.match(
				/^npm run ([\w:-]+)(?:\s+--\s+.+)?$/,
			)?.[1];
			if (!script || !(script in diagnosticScripts)) {
				errors.push(
					`${row.id}: unknown diagnostic script ${script ?? command}`,
				);
			}
		}
		if (
			evidence.knownLimitation &&
			(!evidence.diagnostics.length ||
				!/не гарант|not guaranteed/i.test(row.expected))
		) {
			errors.push(
				`${row.id}: limitation needs a diagnostic and explicit non-guarantee`,
			);
		}
		for (const fragment of evidence.invalidFragments) {
			errors.push(`${row.id}: invalid evidence fragment ${fragment}`);
		}
		for (const name of evidence.autoNames) {
			if (!testNames.has(name)) {
				errors.push(`${row.id}: missing executable test ${name}`);
			}
		}
		for (const manualCase of evidence.manualCases) {
			const coveredScenarios = manualCoverage.get(manualCase);
			if (!coveredScenarios) {
				errors.push(`${row.id}: missing manual case ${manualCase}`);
			} else if (!coveredScenarios.has(row.id)) {
				errors.push(
					`${row.id}: ${manualCase} does not declare this scenario`,
				);
			}
		}
		if (
			(row.priority === "P0" || row.priority === "P1") &&
			evidence.autoNames.length === 0 &&
			!evidence.manualRequired &&
			evidence.manualCases.length === 0 &&
			!evidence.knownLimitation
		) {
			errors.push(
				`${row.id}: P0/P1 scenario has no executable or manual evidence`,
			);
		}
	}
	for (const [manualCase, coveredScenarios] of manualCoverage) {
		for (const id of coveredScenarios) {
			if (!seen.has(id)) {
				errors.push(`${manualCase}: unknown scenario ${id}`);
			}
		}
	}
	return errors;
}
import ts from "typescript";
