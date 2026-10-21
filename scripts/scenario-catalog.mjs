const PRIORITIES = new Set(["P0", "P1", "P2"]);

/** Parse user-scenario rows while ignoring invariant and Markdown header rows. */
export function parseScenarioRows(markdown) {
	return markdown.split("\n").flatMap((line, index) => {
		if (!line.startsWith("|")) {
			return [];
		}
		const cells = line.split("|").map((cell) => cell.trim());
		if (!/^[A-Z]+-\d+$/.test(cells[1] ?? "")) {
			return [];
		}
		if (!PRIORITIES.has(cells[2] ?? "")) {
			return [];
		}
		return [
			{
				id: cells[1],
				priority: cells[2],
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
	let readingAutoNames = false;

	for (const fragment of value.split(";").map((part) => part.trim())) {
		const firstAuto = fragment.match(/^auto:\s*`([^`]+)`$/);
		if (firstAuto) {
			autoNames.push(firstAuto[1]);
			readingAutoNames = true;
			continue;
		}
		const continuedAuto = fragment.match(/^`([^`]+)`$/);
		if (continuedAuto && readingAutoNames) {
			autoNames.push(continuedAuto[1]);
			continue;
		}
		readingAutoNames = false;
		if (fragment === "manual-required") {
			manualRequired = true;
			continue;
		}
		const manual = fragment.match(/^manual:\s*`(TC-\d+)`$/);
		if (manual) {
			manualCases.push(manual[1]);
			continue;
		}
		invalidFragments.push(fragment || "<empty>");
	}

	return { autoNames, manualCases, manualRequired, invalidFragments };
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
	const headings = [...markdown.matchAll(/^## (TC-\d+)\./gm)];
	return new Map(
		headings.map((heading, index) => {
			const start = heading.index ?? 0;
			const end = headings[index + 1]?.index ?? markdown.length;
			const section = markdown.slice(start, end);
			const coverage = section.match(
				/^Покрывает:[^\n]*(?:\n(?!\n)[^\n]*)*/m,
			)?.[0];
			return [
				heading[1],
				new Set(
					[...(coverage ?? "").matchAll(/`([A-Z]+-\d+)`/g)].map(
						(match) => match[1],
					),
				),
			];
		}),
	);
}

/** Validate scenario IDs and their exact automated and manual evidence. */
export function validateScenarioCatalog(markdown, testSources, smokeTests) {
	const rows = parseScenarioRows(markdown);
	const testNames = collectNodeTestNames(testSources);
	const manualCoverage = collectManualCaseCoverage(smokeTests);
	const seen = new Set();
	const errors = [];

	for (const row of rows) {
		if (seen.has(row.id)) {
			errors.push(`${row.id}: duplicate scenario ID`);
		}
		seen.add(row.id);
		const evidence = parseScenarioEvidence(row.evidence);
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
			evidence.manualCases.length === 0
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
