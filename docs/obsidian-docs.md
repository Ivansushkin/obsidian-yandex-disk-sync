Plugins let you extend Obsidian with your own features to create a custom note-taking experience.

In this tutorial, you'll compile a sample plugin from source code and load it into Obsidian.

## What you'll learn

After you've completed this tutorial, you'll be able to:

-   Configure an environment for developing Obsidian plugins.
-   Compile a plugin from source code.
-   Reload a plugin after making changes to it.

## Prerequisites

To complete this tutorial, you'll need:

-   [Git](https://git-scm.com/) installed on your local machine.
-   A local development environment for [Node.js](https://node.js.org/en/about/).
-   A code editor, such as [Visual Studio Code](https://code.visualstudio.com/).

## Before you start

When developing plugins, one mistake can lead to unintended changes to your vault. To prevent data loss, you should never develop plugins in your main vault. Always use a separate vault dedicated to plugin development.

[Create an empty vault](https://help.obsidian.md/Getting+started/Create+a+vault#Create+empty+vault).

## Step 1: Download the sample plugin

In this step, you'll download a sample plugin to the `plugins` directory in your vault's [`.obsidian` directory](https://help.obsidian.md/Advanced+topics/How+Obsidian+stores+data#Per+vault+data) so that Obsidian can find it.

The sample plugin you'll use in this tutorial is available in a [GitHub repository](https://github.com/obsidianmd/obsidian-sample-plugin).

1. Open a terminal window and change the project directory to the `plugins` directory.
    ```
    cd path/to/vault
    mkdir .obsidian/plugins
    cd .obsidian/plugins
    ```
2. Clone the sample plugin using Git.
    ```
    git clone https://github.com/obsidianmd/obsidian-sample-plugin.git
    ```

GitHub template repository

The repository for the sample plugin is a GitHub template repository, which means you can create your own repository from the sample plugin. To learn how, refer to [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template#creating-a-repository-from-a-template).

Remember to use the URL of your own repository when cloning the sample plugin.

## Step 2: Build the plugin

In this step, you'll compile the sample plugin so that Obsidian can load it.

1. Navigate to the plugin directory.
    ```
    cd obsidian-sample-plugin
    ```
2. Install dependencies.
    ```
    npm install
    ```
3. Compile the source code. The following command keeps running in the terminal and rebuilds the plugin when you modify the source code.
    ```
    npm run dev
    ```

Notice that the plugin directory now has a `main.js` file that contains a compiled version of the plugin.

## Step 3: Enable the plugin

To load a plugin in Obsidian, you first need to enable it.

1. In Obsidian, open **Settings**.
2. In the side menu, select **Community plugins**.
3. Select **Turn on community plugins**.
4. Under **Installed plugins**, enable the **Sample Plugin** by selecting the toggle button next to it.

You're now ready to use the plugin in Obsidian. Next, we'll make some changes to the plugin.

## Step 4: Update the plugin manifest

In this step, you'll rename the plugin by updating the plugin manifest, `manifest.json`. The manifest contains information about your plugin, such as its name and description.

1. Open `manifest.json` in your code editor.
2. Change `id` to a unique identifier, such as `"hello-world"`.
3. Change `name` to a human-friendly name, such as `"Hello world"`.
4. Rename the plugin folder to match the plugin's `id`.
5. Restart Obsidian to load the new changes to the plugin manifest.

Go back to **Installed plugins** and notice that the name of the plugin has been updated to reflect the changes you made.

Remember to restart Obsidian whenever you make changes to `manifest.json`.

## Step 5: Update the source code

To let the user interact with your plugin, add a _ribbon icon_ that greets the user when they select it.

1. Open `main.ts` in your code editor.
2. Rename the plugin class from `MyPlugin` to `HelloWorldPlugin`.
3. Import `Notice` from the `obsidian` package.
    ```
    import { Notice, Plugin } from 'obsidian';
    ```
4. In the `onload()` method, add the following code:
    ```
    this.addRibbonIcon('dice', 'Greet', () => {
      new Notice('Hello, world!');
    });
    ```
5. In the **Command palette**, select **Reload app without saving** to reload the plugin.

You can now see a dice icon in the ribbon on the left side of the Obsidian window. Select it to display a message in the upper-right corner.

Remember, you need to **reload your plugin after changing the source code**, either by disabling it then enabling it again in the community plugins panel, or using the command palette as detailed in part 5 of this step.

Hot reloading

Install the [Hot-Reload](https://github.com/pjeby/hot-reload) plugin to automatically reload your plugin while developing.

## Conclusion

In this tutorial, you've built your first Obsidian plugin using the TypeScript API. You've modified the plugin and reloaded it to reflect the changes inside Obsidian.

Links to this page

[Build a Bases view](https://docs.obsidian.md/plugins/guides/bases-view)

[Home](https://docs.obsidian.md/Home)

[Use Svelte in your plugin](https://docs.obsidian.md/Plugins/Getting+started/Use+Svelte+in+your+plugin)

---

The [Plugin](https://docs.obsidian.md/Reference/TypeScript+API/Plugin) class defines the lifecycle of a plugin and exposes the operations available to all plugins:

```
import { Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    // Configure resources needed by the plugin.
  }
  async onunload() {
    // Release any resources configured by the plugin.
  }
}
```

## Plugin lifecycle

[onload()](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/onload) runs whenever the user starts using the plugin in Obsidian. This is where you'll configure most of the plugin's capabilities.

[onunload()](https://docs.obsidian.md/Reference/TypeScript+API/Component/onunload) runs when the plugin is disabled. Any resources that your plugin is using must be released here to avoid affecting the performance of Obsidian after your plugin has been disabled.

To better understand when these methods are called, you can print a message to the console whenever the plugin loads and unloads. The console is a valuable tool that lets developers monitor the status of their code.

To view the console:

1. Toggle the Developer Tools by pressing Ctrl+Shift+I in Windows and Linux, or Cmd-Option-I on macOS.
2. Click on the Console tab in the Developer Tools window.

```
import { Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    console.log('loading plugin')
  }
  async onunload() {
    console.log('unloading plugin')
  }
}
```

---

[Developer Documentation](https://docs.obsidian.md/Home)

Whenever you make a change to the plugin source code, the plugin needs to be reloaded. You can reload the plugin by quitting Obsidian and starting it again, but that gets tiring quickly.

## Reload plugin inside Obsidian

You can reload the plugin by re-enabling it in the list of installed plugins:

1. Open **Preferences**.
2. Click **Community plugins**.
3. Find your plugin under **Installed plugins**.
4. Toggle the switch off to disable the plugin.
5. Toggle the switch on to enable the plugin.

You're now running the updated version of your plugin.

## Reload plugin on file changes

The [Hot-Reload](https://github.com/pjeby/hot-reload) plugin reloads your plugin whenever the source code changes.

For more information, check out the [forum announcement](https://forum.obsidian.md/t/plugin-release-for-developers-hot-reload-the-plugin-s-youre-developing/12185).

Development workflow

Interactive graph

Reload plugin inside Obsidian

Reload plugin on file changes

---

Learn how you can develop your plugin for mobile devices.

## Emulate mobile device on desktop

You can emulate Obsidian running a mobile device directly from the Developer Tools.

1. Open the **Developer Tools**.
2. Select the **Console** tab.
3. Enter the following and then press `Enter`.
    ```ts
    this.app.emulateMobile(true);
    ```

To disable mobile emulation, enter the following and press `Enter`:

```ts
this.app.emulateMobile(false);
```

Tip

To instead toggle mobile emulation back and forth, you can use the `this.app.isMobile` flag:

```ts
this.app.emulateMobile(!this.app.isMobile);
```

## Inspecting the webview on the actual mobile device

### Android

You can inspect Obsidian running on an Android device if you enable USB Debugging in Developer settings of Android. Then go to a chromium based browser on your desktop/laptop and navigate to chrome://inspect/. If you did everything right, if you have your phone/tablet connected to your PC via USB and the browser open at that link you should see your device pop up and it will let you run the usual devtools from there on it.

More in depth information can be found here: [https://developer.chrome.com/docs/devtools/remote-debugging](https://developer.chrome.com/docs/devtools/remote-debugging)

### iOS

You can inspect Obsidian on an iOS device running 16.4 or later and a macOS based computer. Instructions on how to set it up can be found here: [https://webkit.org/web-inspector/enabling-web-inspector/](https://webkit.org/web-inspector/enabling-web-inspector/)

## Platform-specific features

To detect the platform your plugin is running on, you can use [Platform](https://docs.obsidian.md/Reference/TypeScript+API/Platform):

```ts
import { Platform } from "obsidian";

if (Platform.isIosApp) {
	// ...
}

if (Platform.isAndroidApp) {
	// ...
}
```

## Disable your plugin on mobile devices

If your plugin requires the Node.js or Electron API, you can prevent users from installing the plugin on mobile devices.

To only support the desktop app, set `isDesktopOnly` to `true` in the [Manifest](https://docs.obsidian.md/Reference/Manifest).

## Troubleshooting

This section lists common issues when developing for mobile devices.

### Node and Electron APIs

The Node.js API, and the Electron API aren't available on mobile devices. Any calls to these libraries made by your plugin or it's dependencies can cause your plugin to crash.

### Lookbehind in regular expressions

Lookbehind in regular expressions is only supported on iOS 16.4 and above, and some iPhone and iPad users may still use earlier versions. To implement a fallback for iOS users, either refer to [Platform-specific features](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development#Platform-specific%20features), or use a JavaScript library to detect specific browser versions.

Refer to [Can I Use](https://caniuse.com/js-regexp-lookbehind) for more information and exact version statistics. Look for "Safari on iOS".

---

In this guide, you'll configure your plugin to use [React](https://react.dev/). It assumes that you already have a plugin with a [custom view](https://docs.obsidian.md/Plugins/User+interface/Views) that you want to convert to use React.

While you don't need to use a separate framework to build a plugin, there are a few reasons why you'd want to use React:

-   You have existing experience of React and want to use a familiar technology.
-   You have existing React components that you want to reuse in your plugin.
-   Your plugin requires complex state management or other features that can be cumbersome to implement with regular [HTML elements](https://docs.obsidian.md/Plugins/User+interface/HTML+elements).

## Configure your plugin

1. Add React to your plugin dependencies:
    ```bash
    npm install react react-dom
    ```
2. Add type definitions for React:
    ```bash
    npm install --save-dev @types/react @types/react-dom
    ```
3. In `tsconfig.json`, enable JSX support on the `compilerOptions` object:
    ```ts
    {
      "compilerOptions": {
        "jsx": "react-jsx"
      }
    }
    ```

## Create a React component

Create a new file called `ReactView.tsx` in the plugin root directory, with the following content:

```tsx
export const ReactView = () => {
	return <h4>Hello, React!</h4>;
};
```

## Mount the React component

To use the React component, it needs to be mounted on a [HTML element](https://docs.obsidian.md/Plugins/User+interface/HTML+elements). The following example mounts the `ReactView` component on the `this.contentEl` element:

```tsx
import { StrictMode } from "react";
import { ItemView, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import { ReactView } from "./ReactView";

const VIEW_TYPE_EXAMPLE = "example-view";

class ExampleView extends ItemView {
	root: Root | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_EXAMPLE;
	}

	getDisplayText() {
		return "Example view";
	}

	async onOpen() {
		this.root = createRoot(this.contentEl);
		this.root.render(
			<StrictMode>
				<ReactView />,
			</StrictMode>
		);
	}

	async onClose() {
		this.root?.unmount();
	}
}
```

For more information on `createRoot` and `unmount()`, refer to the documentation on [ReactDOM](https://react.dev/reference/react-dom/client/createRoot#root-render).

You can mount your React component on any `HTMLElement`, for example [status bar items](https://docs.obsidian.md/Plugins/User+interface/Status+bar). Just make sure to clean up properly by calling `this.root.unmount()` when you're done.

## Create an App context

If you want to access the [App](https://docs.obsidian.md/Reference/TypeScript+API/App) object from one of your React components, you need to pass it as a dependency. As your plugin grows, even though you're only using the `App` object in a few places, you start passing it through the whole component tree.

Another alternative is to create a React context for the app to make it globally available to all components inside your React view.

1. Use `createContext()` to create a new app context.
    ```tsx
    import { createContext } from "react";
    import { App } from "obsidian";
    export const AppContext = createContext<App | undefined>(undefined);
    ```
2. Wrap the `ReactView` with a context provider and pass the app as the value.
    ```tsx
    this.root = createRoot(this.contentEl);
    this.root.render(
    	<AppContext.Provider value={this.app}>
    		<ReactView />
    	</AppContext.Provider>
    );
    ```
3. Create a custom hook to make it easier to use the context in your components.
    ```tsx
    import { useContext } from "react";
    import { AppContext } from "./context";
    export const useApp = (): App | undefined => {
    	return useContext(AppContext);
    };
    ```
4. Use the hook in any React component within `ReactView` to access the app.
    ```tsx
    import { useApp } from "./hooks";
    export const ReactView = () => {
    	const { vault } = useApp();
    	return <h4>{vault.getName()}</h4>;
    };
    ```

For more information, refer to the React documentation for [Passing Data Deeply with Context](https://react.dev/learn/passing-data-deeply-with-context) and [Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks).

---

Bases is a core plugin in Obsidian which display dynamic views of your notes as tables, cards, lists, and more. If you're unfamiliar with Bases, please read about them in the [help docs](https://help.obsidian.md/bases) before getting started.

Plugins can use the Obsidian API to create completely custom views of the data powering Bases. In this guide, you'll walk through extending the sample plugin to create a simplified version of the list view.

## What you'll learn

After you've completed this guide, you'll be able to:

-   Create a custom [Bases view](https://help.obsidian.md/bases/views).
-   Dynamically render data from note properties in a list format.

## Prerequisites

To complete this guide, you'll need:

-   [Git](https://git-scm.com/) installed on your local machine.
-   A local development environment for [Node.js](https://node.js.org/en/about/).
-   A code editor, such as [Visual Studio Code](https://code.visualstudio.com/).

Additionally, this guide will build off of the sample plugin created in a previous guide. Follow the [Build a plugin](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin) guide before starting this guide.

## Before you start

When developing plugins, one mistake can lead to unintended changes to your vault. To prevent data loss, you should never develop plugins in your main vault. Always use a separate vault dedicated to plugin development.

[Create an empty vault](https://help.obsidian.md/Getting+started/Create+a+vault#Create+empty+vault).

## Step 1: Sample plugin setup

In this guide it is assumed that you have a directory on your computer with the sample plugin and that you know how to build your plugin and test it in Obsidian.

For the purposes of this list view plugin, we can remove a large portion of the code from the `MyPlugin` class, leaving just the `onload` function.

```typescript
export default class MyPlugin extends Plugin {
	async onload() {}
}
```

Once you have an empty plugin which can be built and loaded into Obsidian, you can begin building a Bases view. Start with a view that statically displays "Hello World".

```typescript
export const ExampleViewType = "example-view";

export default class MyPlugin extends Plugin {
	async onload() {
		// Tell Obsidian about the new view type that this plugin provides.
		this.registerBasesView(ExampleViewType, {
			name: "Example",
			icon: "lucide-graduation-cap",
			factory: (controller, containerEl) => {
				new MyBasesView(controller, containerEl);
			},
		});
	}
}

export class MyBasesView extends BasesView {
	readonly type = ExampleViewType;
	private containerEl: HTMLElement;

	constructor(controller: QueryController, parentEl: HTMLElement) {
		super(controller);
		this.containerEl = parentEl.createDiv("bases-example-view-container");
	}

	// onDataUpdated is called by Obsidian whenever there is a configuration
	// or data change in the vault which may affect your view. For now,
	// simply draw "Hello World" to screen.
	public onDataUpdated(): void {
		this.containerEl.empty();
		this.containerEl.createDiv({ text: "Hello World" });
	}
}
```

Build your plugin, reload the app, and create a new Base file. Use the menu on the left of the toolbar, and select the right chevron next to the view in the list. From this menu, change the layout to your newly created "Example" view type.

## Step 3: Add configuration

In your IDE, you can view the definition of `ViewOption` to see the different controls available. Each control will create an entry in the view configuration menu, and user input will automatically be stored in the Bases configuration file.

```typescript
export default class MyPlugin extends Plugin {
	async onload() {
		// Tell Obsidian about the new view type that this plugin provides.
		this.registerBasesView(ExampleViewType, {
			name: "Example",
			icon: "lucide-graduation-cap",
			factory: (controller, containerEl) => {
				new MyBasesView(controller, containerEl);
			},
			options: () => [
				{
					// The type of option. 'text' is a text input.
					type: "text",
					// The name displayed in the settings menu.
					displayName: "Property separator",
					// The value saved to the view settings.
					key: "separator",
					// The default value for this option.
					default: " - ",
				},
				// ...
			],
		});
	}
}
```

![example-bases-view-configuration.gif > interface](https://publish-01.obsidian.md/access/caa27d6312fe5c26ebc657cc609543be/Assets/example-bases-view-configuration.gif)

example-bases-view-configuration.gif > interface

## Step 4: Display list items

The final step in creating a new Bases view is to transform the data from properties into the format you want to display. Obsidian will call the `onDataUpdated` method on your view whenever there are changes to the data. To keep this example simple, the code below clears the container, and rerenders a list entry for every file provided in the data set. It is important, however, to keep in mind the best practices of web development. An unfiltered Base will provide an entry for every file in the vault, so your view should be able to handle thousands of entries, reuse DOM elements, and avoid rendering off screen where appropriate.

```typescript
// Add \`implements HoverParent\` to enable hovering over file links.
export class MyBasesView extends BasesView implements HoverParent {
	hoverPopover: HoverPopover | null;

	// ...

	public onDataUpdated(): void {
		const { app } = this;

		// Retrieve the user configured order set in the Properties menu.
		const order = this.config.getOrder();

		// Clear entries created by previous iterations. Remember, you should
		// instead attempt element reuse when possible.
		this.containerEl.empty();

		// The property separator configured by the ViewOptions above can be
		// retrieved from the view config. Be sure to set a default value.
		const propertySeparator = String(this.config.get("separator")) || " - ";

		// this.data contains both grouped and ungrouped versions of the data.
		// If it's appropriate for your view type, use the grouped form.
		for (const group of this.data.groupedData) {
			const groupEl = this.containerEl.createDiv("bases-list-group");
			const groupListEl = groupEl.createEl("ul", "bases-list-group-list");

			// Each entry in the group is a separate file in the vault matching
			// the Base filters. For list view, each entry is a separate line.
			for (const entry of group.entries) {
				groupListEl.createEl("li", "bases-list-entry", (el) => {
					let firstProp = true;
					for (const propertyName of order) {
						// Properties in the order can be parsed to determine what type
						// they are: formula, note, or file.
						const { type, name } = parsePropertyId(propertyName);

						// \`entry.getValue\` returns the evaluated result of the property
						// in the context of this entry.
						const value = entry.getValue(propertyName);

						// Skip rendering properties which have an empty value.
						// The list items for each file may have differing length.
						if (value.isEmpty()) continue;

						if (!firstProp) {
							el.createSpan({
								cls: "bases-list-separator",
								text: propertySeparator,
							});
						}
						firstProp = false;

						// If the \`file.name\` property is included in the order, render
						// it specially so that it links to that file.
						if (name === "name" && type === "file") {
							const fileName = String(entry.file.name);
							const linkEl = el.createEl("a", { text: fileName });
							linkEl.onClickEvent((evt) => {
								if (evt.button !== 0 && evt.button !== 1)
									return;
								evt.preventDefault();
								const path = entry.file.path;
								const modEvent = Keymap.isModEvent(evt);
								void app.workspace.openLinkText(
									path,
									"",
									modEvent
								);
							});

							linkEl.addEventListener("mouseover", (evt) => {
								app.workspace.trigger("hover-link", {
									event: evt,
									source: "bases",
									hoverParent: this,
									targetEl: linkEl,
									linktext: entry.file.path,
								});
							});
						}
						// For all other properties, just display the value as text.
						// In your view you may also choose to use the \`Value.renderTo\`
						// API to better support photos, links, icons, etc.
						else {
							el.createSpan({
								cls: "bases-list-entry-property",
								text: value.toString(),
							});
						}
					}
				});
			}
		}
	}
}
```

Rebuild your plugin and reload the app. Your Base should now display a list item for every file in the vault!

## Conclusion

Congratulations on building your first Bases view! Bases are a powerful new way to view the data in your vault and we can't wait to see what new views you create.

This website contains the full API reference for Bases. Here are a couple places to get started:

If you have any questions, please join the [Obsidian Discord server](https://discord.gg/obsidianmd) and ask in the "obsidian-bases" or "plugin-dev" channels.

---

As of Obsidian v1.7.2, When Obsidian loads, all views are created as instances of **DeferredView**. Once a view is visible on screen (i.e. the tab is selected within its containing tab group), the `leaf` will rerender and the view will be switched out to the correct `View` instance.

This change might break some assumptions that your plugin is currently making.

### Accessing leaf.view

If your plugin is iterating the workspace (using either `iterateAllLeaves` or `getLeavesOfType`), it's now very important that you perform an `instanceof` check before making any assumptions about `leaf.view`.

```ts
// Bad
workspace.iterateAllLeaves(leaf => {
    if (leaf.view.getViewType() === 'my-view') {
        let view = leaf.view as MyCustomView;
        ...
    }
});

// Good
workspace.iterateAllLeaves(leaf => {
    if (leaf.view instanceof MyCustomView) {
        ...
    }
});
```

```ts
// Bad
let leaf = workspace.getLeavesOfType('my-view').first();
if (leaf) {
    let view = leaf.view as MyCustomView;
}
...

// Good
let leaf = workspace.getLeavesOfType('my-view').first();
if (leaf && leaf.view instanceof MyCustomView) {
    ...
}
```

This will avoid your plugin breaking by making a bad assumption about the workspace and causing your plugin to error out.

### Accessing your CustomView anywhere in the workspace

> A general rule to follow: if your plugin is attempting to communicate with a view, that view should be visible.

If your plugin needs to access an instance of `CustomView` in the workspace, you might notice that the previous code snippets won't work.

For most use cases, the solution is simple:

```ts
let leaf = workspace.getLeavesOfType("my-view").first();
if (leaf) {
	await workspace.revealLeaf(leaf); // Ensure the view is visible, \`await\` it to make sure the view is fully loaded
	if (leaf.view instanceof MyCustomView) {
		let view = leaf.view; // You now have your CustomView
	}
}
```

For most cases, this will be the correct way to handle accessing your custom view.

### Accessing your CustomView without reveal (Advanced)

There are some cases where you want to access a view without revealing it. For example, if your plugin is applying modifications to an existing view type.

In this case, you will need to manually request that the view is loaded.

```ts
let leaves = workspace.getLeavesOfType("my-view");
for (let leaf of leaves) {
	if (requireApiVersion("1.7.2")) {
		await leaf.loadIfDeferred(); // Ensure view is fully loaded
	}
	// perform modifications here...
}
```

Performance warning

Manually calling `loadIfDeferred`, your plugin is removing this performance optimization from the given views. Use this _sparingly_.

---

Plugins play an important role in app load time. To ensure that Obsidian behaves correctly, Obsidian loads all plugins before the user can interact with the app.

You can test the startup time of Obsidian by going to **Settings** → **General** → **Advanced**. and select the stopwatch icon to debug startup time. This view indicates how long it takes for the app to launch.

### How do I improve my plugin's load time?

-   Simplify your plugin `onload`.
-   Check your plugin View constructor.
-   Avoid the [common pitfalls](https://docs.obsidian.md/plugins/guides/load-time#Pitfalls).

First, the easy stuff. Make sure that you are using a production build of your plugin. If you are using a bundler like esbuild, rollup, or webpack, you can likely create a "development" build or a "production" build. A production build will usually be smaller, load faster, and remove code that's only used for testing. When you create a release, ensure that the `main.js` file is a production build.

In your build configuration, you should consider minifying your plugin code. This will make the overall plugin file size smaller and therefore faster for plugin to read from disk and load.

Next, make sure you aren't doing anything expensive inside your plugin's `onload` function. The `onload` function should only include code necessary for the plugin to initialize. This includes app registrations, like registering commands, view types, and Markdown post-processors. It should not include anything computationally expensive or data fetching.

If your plugin creates any custom views, be mindful of your custom view constructor. When Obsidian opens, it will reopen all the views saved to the user's workspace. If your view is loaded (and not [deferred](https://docs.obsidian.md/plugins/guides/defer-views)), this will directly impact the app load time.

### If you have code that you want to run at startup, where should it go?

For most cases, you will want to wrap your code inside a `onLayoutReady` callback. These callbacks are deferred and are only called after Obsidian finishes loading.

## Pitfalls

### Listening to vault.on('create')

As a part of Obsidian's vault initialization process, it will call `create` for every file. If your plugin needs to react to new files getting created, you need to wait for the workspace to be ready first. Your vault event registration should be inside an `onLayoutReady` callback; this will ensure you don't start reacting to events until the workspace is fully initialized.

#### Option A. Check if the layout is ready

```ts
class MyPlugin extends Plugin {
	onload(app: App) {
		super(app);
		this.registerEvent(this.app.vault.on("create", this.onCreate, this));
	}

	onCreate() {
		if (!this.app.workspace.layoutReady) {
			// Workspace is still loading, do nothing
			return;
		}
		// ...
	}
}
```

```ts
class MyPlugin extends Plugin {
	onload(app: App) {
		super(app);
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", this.onCreate, this)
			);
		});
	}

	onCreate() {
		// ...
	}
}
```

For additional help with optimizing your plugin, reach out for [help from the developer community](https://docs.obsidian.md/Home#Join%20the%20developer%20community)!

---

[SecretStorage](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage) provides a secure way to store and manage sensitive data like API keys and tokens in Obsidian plugins. Instead of storing secrets directly in your plugin's `data.json` file, SecretStorage offers a centralized key-value store that allows users to share secrets across multiple plugins.

In this guide, you'll learn how to use [SecretStorage](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage) and [SecretComponent](https://docs.obsidian.md/Reference/TypeScript+API/SecretComponent) to securely handle secrets in your plugin settings.

## What you'll learn

After you've completed this guide, you'll be able to:

-   Replace direct secret input with the SecretComponent.
-   Retrieve stored secrets using the SecretStorage API.
-   Understand why SecretStorage improves security and user experience.

## Before you start

This guide assumes you're familiar with creating plugin settings in Obsidian. If you haven't already, read [Settings](https://docs.obsidian.md/Plugins/User+interface/Settings) to understand how to create a settings tab and save plugin configuration.

## Why use SecretStorage?

When plugins store secrets directly in `data.json`, several problems arise:

-   **Security**: Secrets are stored in plaintext alongside other plugin data.
-   **Duplication**: Users must copy the same API key into every plugin that needs it.
-   **Maintenance**: If a token changes, users must update every plugin manually.

SecretStorage addresses these issues by providing a central store for secrets. Users save each secret with a name, and any plugin can reference it by that name.

![settings-secret-list.png](https://publish-01.obsidian.md/access/caa27d6312fe5c26ebc657cc609543be/Assets/settings-secret-list.png)

## Step 1: Update your settings interface

Start with a typical plugin settings setup. The `mySetting` property will store the _name_ of a secret, not the secret value itself.

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	mySetting: string;
}
```

## Step 2: Add the SecretComponent to your settings tab

Replace the standard text input with a `SecretComponent`. Import `SecretComponent` from `obsidian` and use the `addComponent` method on your `Setting`:

```ts
import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import MyPlugin from "./main";

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Select a secret from SecretStorage")
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.mySetting)
					.onChange((value) => {
						this.plugin.settings.mySetting = value;
						this.plugin.saveSettings();
					})
			);
	}
}
```

The `SecretComponent` presents users with an interface to select from existing secrets or create a new one. When saved, your plugin settings contain the _name_ of the secret, not the actual secret value.

![settings-secretcomponent.png](https://publish-01.obsidian.md/access/caa27d6312fe5c26ebc657cc609543be/Assets/settings-secretcomponent.png)

## Step 3: Retrieve the secret value

When your plugin needs the actual secret value, use the `SecretStorage` API:

```ts
const secret = app.secretStorage.get(this.settings.mySetting);
if (secret) {
	// secret value might be null
}
```

This retrieves the secret value associated with the name stored in your settings. The actual secret is stored in local storage, keyed to the specific vault.

## Complete example

Here's the full settings tab implementation:

```ts
import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	mySetting: string;
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Select a secret from SecretStorage")
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.mySetting)
					.onChange((value) => {
						this.plugin.settings.mySetting = value;
						this.plugin.saveSettings();
					})
			);
	}
}
```

## FAQ

### Why does SecretComponent use addComponent instead of having its own method like addText?

Unlike other setting components, `SecretComponent` requires the `App` instance in its constructor to access the SecretStorage API. The standard `addText`, `addToggle`, and similar methods don't pass `App` to their callbacks. The `Setting#addComponent` method gives you full control over component instantiation, allowing you to pass the required `App` reference.

---

With the release of [Obsidian v0.15.0](https://obsidian.md/changelog/2022-06-14-desktop-v0.15.0/), the pop-out windows feature was added to the desktop version of Obsidian.

For most plugins, this feature should work out-of-the-box. However, some things work differently when your plugin renders things in pop-out windows.

Most importantly, pop-out windows come with a complete different set of globals. Each pop-out window introduces its own `Window` object, `Document` object, and fresh copies of all global constructors (like `HTMLElement` and `MouseEvent`).

This means that some of the things you previously had assumed to be global and use only _a single_ definition, will now only work in the main window. Here are some examples:

```ts
let myElement: HTMLElement = ...;

// This will always append to the main window
document.body.appendChild(myElement);

// This will actually be false if element is in a pop-out window
if (myElement instanceof HTMLElement) {

}

element.on('click', '.my-css-class', (event) => {
    // This will be false if the event is triggered in a pop-out window
    if (event instanceof MouseEvent) {

    }
}
```

The Obsidian API includes various helper function and accessors to better support pop-out windows:

-   A global `activeWindow` and `activeDocument` variable, which always points to the current focused window and its document.
-   An `element.win` and `element.doc` getter, which respectively point to the `Window` and `Document` objects that the element belongs to.
-   A function for performing cross-window compatible `instanceof` checks. Use `element.instanceOf(HTMLElement)` and `event.instanceOf(MouseEvent)`, instead of `element instanceof HTMLElement` and `event instanceof MouseEvent`.
-   `HTMLElement.onWindowMigrated(callback)` which hooks a callback on the element for when it is inserted into a different window than it originally was in. This can be used for complex renderers like canvases to re-initialize the rendering context.

Using these APIs, the previous example would look like this:

```ts
let myElement: HTMLElement = ...;

// Bad: myElement would be added to the currently focused document, which is not necessarily the one you want
activeDocument.body.appendChild(myElement);
// Good: This will append myElement to the same window as someElement
someElement.doc.body.appendChild(myElement);

// This will work correctly in pop-out windows
if (myElement.instanceOf(HTMLElement)) {

}

element.on('click', '.my-css-class', (event) => {
    // This will work correctly in pop-out windows
    if (event.instanceOf(MouseEvent)) {

    }
}
```

---

Commands are actions that the user can invoke from the [Command Palette](https://help.obsidian.md/Plugins/Command+palette) or by using a hot key.

![command.png](https://publish-01.obsidian.md/access/caa27d6312fe5c26ebc657cc609543be/Assets/command.png)

```ts
import { Plugin } from "obsidian";

export default class ExamplePlugin extends Plugin {
	async onload() {
		this.addCommand({
			id: "print-greeting-to-console",
			name: "Print greeting to console",
			callback: () => {
				console.log("Hey, you!");
			},
		});
	}
}
```

## Conditional commands

If your command is only able to run under certain conditions, consider using [checkCallback()](https://docs.obsidian.md/Reference/TypeScript+API/Command/checkCallback) instead.

The `checkCallback` runs twice. First, to perform a preliminary check to determine whether the command can run. Second, to perform the action.

Since time may pass between the two runs, you need to perform the check during both calls.

To determine whether the callback should perform a preliminary check or an action, a `checking` argument is passed to the callback.

-   If `checking` is set to `true`, perform a preliminary check.
-   If `checking` is set to `false`, perform an action.

The command in the following example depends on a required value. In both runs, the callback checks that the value is present but only performs the action if `checking` is `false`.

```ts
this.addCommand({
	id: "example-command",
	name: "Example command",
	// highlight-next-line
	checkCallback: (checking: boolean) => {
		const value = getRequiredValue();

		if (value) {
			if (!checking) {
				doCommand(value);
			}

			return true;
		}

		return false;
	},
});
```

## Editor commands

If your command needs access to the editor, you can also use the [editorCallback()](https://docs.obsidian.md/Reference/TypeScript+API/Command/editorCallback), which provides the active editor and its view as arguments.

```ts
this.addCommand({
  id: 'example-command',
  name: 'Example command',
  editorCallback: (editor: Editor, view: MarkdownView) => {
    const sel = editor.getSelection()

    console.log(\`You have selected: ${sel}\`);
  },
}
```

Note

Editor commands only appear in the Command Palette when there's an active editor available.

If the editor callback can only run under certain conditions, consider using [editorCheckCallback()](https://docs.obsidian.md/Reference/TypeScript+API/Command/editorCheckCallback) instead. For more information, refer to [Conditional commands](https://docs.obsidian.md/Plugins/User+interface/Commands#Conditional%20commands).

```ts
this.addCommand({
	id: "example-command",
	name: "Example command",
	editorCheckCallback: (
		checking: boolean,
		editor: Editor,
		view: MarkdownView
	) => {
		const value = getRequiredValue();

		if (value) {
			if (!checking) {
				doCommand(value);
			}

			return true;
		}

		return false;
	},
});
```

## Hot keys

The user can run commands using a keyboard shortcut, or _hot key_. While they can configure this themselves, you can also provide a default hot key.

Warning

Avoid setting default hot keys for plugins that you intend for others to use. Hot keys are highly likely to conflict with those defined by other plugins or by the user themselves.

In this example, the user can run the command by pressing and holding Ctrl (or Cmd on Mac) and Shift together, and then pressing the letter `a` on their keyboard.

```ts
this.addCommand({
	id: "example-command",
	name: "Example command",
	hotkeys: [{ modifiers: ["Mod", "Shift"], key: "a" }],
	callback: () => {
		console.log("Hey, you!");
	},
});
```

Note

The Mod key is a special modifier key that becomes Ctrl on Windows and Linux, and Cmd on macOS.

---

[Developer Documentation](https://docs.obsidian.md/Home)

```ts
import { Menu, Notice, Plugin } from "obsidian";

export default class ExamplePlugin extends Plugin {
	async onload() {
		this.addRibbonIcon("dice", "Open menu", (event) => {
			const menu = new Menu();

			menu.addItem((item) =>
				item
					.setTitle("Copy")
					.setIcon("documents")
					.onClick(() => {
						new Notice("Copied");
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Paste")
					.setIcon("paste")
					.onClick(() => {
						new Notice("Pasted");
					})
			);

			menu.showAtMouseEvent(event);
		});
	}
}
```

Tip

If you need more control of where the menu appears, you can use `menu.showAtPosition({ x: 20, y: 20 })` to open the menu at a position relative to the top-left corner of the Obsidian window.

For more information on what icons you can use, refer to [Icons](https://docs.obsidian.md/Plugins/User+interface/Icons).

![context-menu-positions.png](https://publish-01.obsidian.md/access/caa27d6312fe5c26ebc657cc609543be/Assets/context-menu-positions.png)

```ts
import { Notice, Plugin } from "obsidian";

export default class ExamplePlugin extends Plugin {
	async onload() {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item.setTitle("Print file path 👈")
						.setIcon("document")
						.onClick(async () => {
							new Notice(file.path);
						});
				});
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				menu.addItem((item) => {
					item.setTitle("Print file path 👈")
						.setIcon("document")
						.onClick(async () => {
							new Notice(view.file.path);
						});
				});
			})
		);
	}
}
```

For more information on handling events, refer to [Events](https://docs.obsidian.md/Plugins/Events).

Modals

Interactive graph

Accept user input

Select from list of suggestions

Approximate string matching results

Custom rendering of fuzzy search results

---

[Developer Documentation](https://docs.obsidian.md/Home)

```ts
import { Plugin } from "obsidian";

export default class ExamplePlugin extends Plugin {
	async onload() {
		this.registerEvent(
			this.app.vault.on("create", () => {
				console.log("a new file has entered the arena");
			})
		);
	}
}
```

## Timing events

The following example displays the current time in the status bar, updated every second:

```ts
import { moment, Plugin } from "obsidian";

export default class ExamplePlugin extends Plugin {
	statusBar: HTMLElement;

	async onload() {
		this.statusBar = this.addStatusBarItem();

		this.updateStatusBar();

		this.registerInterval(
			window.setInterval(() => this.updateStatusBar(), 1000)
		);
	}

	updateStatusBar() {
		this.statusBar.setText(moment().format("H:mm:ss"));
	}
}
```

Date and time

[Moment](https://momentjs.com/) is a popular JavaScript library for working with dates and time. Obsidian uses Moment internally, so you don't need to install it yourself. You can import it from the Obsidian API instead:

```ts
import { moment } from "obsidian";
```

Events

Interactive graph

Timing events

---

Each collection of notes in Obsidian is known as a Vault. A Vault consists of a folder, and any sub-folders within it.

While your plugin can access the file system like any other Node.js application, the [Vault](https://docs.obsidian.md/Reference/TypeScript+API/Vault) module aims to make it easier to work with files and folders within a Vault.

Note

The Vault API only allows access to the files visible inside the app, files included in hidden folders can only be accessed using the Adapter API.

The following example recursively prints the paths of all Markdown files in a Vault:

```ts
const files = this.app.vault.getMarkdownFiles();

for (let i = 0; i < files.length; i++) {
	console.log(files[i].path);
}
```

Tip

If you want to list _all_ files, and not just Markdown documents, use [getFiles()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/getFiles) instead.

## Read files

There are two methods for reading the content of a file: [read()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/read) and [cachedRead()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/cachedRead).

-   If you only want to display the content to the user, then use `cachedRead()` to avoid reading the file from disk multiple times.
-   If you want to read the content, change it, and then write it back to disk, then use `read()` to avoid potentially overwriting the file with a stale copy.

Info

The only difference between `cachedRead()` and `read()` is when the file was modified outside of Obsidian just before the plugin reads it. As soon as the file system notifies Obsidian that the file has changed from the outside, `cachedRead()` behaves _exactly_ like `read()`. Similarly, if you save the file within Obsidian, the read cache is flushed as well.

The following example reads the content of all Markdown files in the Vault and returns the average document size:

```ts
import { Notice, Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    this.addRibbonIcon('info', 'Calculate average file length', async () => {
      const fileLength = await this.averageFileLength();
      new Notice(\`The average file length is ${fileLength} characters.\`);
    });
  }

  async averageFileLength(): Promise<number> {
    const { vault } = this.app;

    const fileContents: string[] = await Promise.all(
      vault.getMarkdownFiles().map((file) => vault.cachedRead(file))
    );

    let totalLength = 0;
    fileContents.forEach((content) => {
      totalLength += content.length;
    });

    return totalLength / fileContents.length;
  }
}
```

## Modify files

To write text content to an existing file, use [Vault.modify()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/modify).

```ts
function writeCurrentDate(vault: Vault, file: TFile): Promise<void> {
  return vault.modify(file, \`Today is ${new Intl.DateTimeFormat().format(new Date())}.\`);
}
```

If you want to modify a file based on its current content, use [Vault.process()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/process) instead. The second argument is a callback that provides the current file content and returns the modified content.

```ts
// emojify replaces all occurrences of :) with 🙂.
function emojify(vault: Vault, file: TFile): Promise<string> {
	return vault.process(file, (data) => {
		return data.replace(":)", "🙂");
	});
}
```

`Vault.process()` is an abstraction on top of [Vault.read()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/read) and [Vault.modify()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/modify) that guarantees that the file doesn't change between reading the current content and writing the updated content. Always prefer `Vault.process()` over `Vault.read()` / `Vault.modify()` to avoid unintentional loss of data.

### Asynchronous modifications

[Vault.process()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/process) only supports synchronous modifications. If you need to modify a file asynchronously:

1. Read the file using [Vault.cachedRead()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/cachedRead).
2. Perform the async operations.
3. Update the file using [Vault.process()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/process).

Remember to check that the `data` in the `process()` callback is the same as the data returned by `cachedRead()`. If they aren't the same, that means that the file was changed by a different process, and you may want to ask the user for confirmation, or try again.

## Delete files

There are two methods to delete a file, [delete()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/delete), and [trash()](https://docs.obsidian.md/Reference/TypeScript+API/Vault/trash). Which one you should use depends on if you want to allow the user to change their mind.

-   `delete()` removes the file without a trace.
-   `trash()` moves the file to the trash bin.

When you use `trash()`, you have the option to move the file to the system's trash bin, or to a local `.trash` folder at the root of the user's Vault.

## Is it a file or folder?

Some operations return or accept a [TAbstractFile](https://docs.obsidian.md/Reference/TypeScript+API/TAbstractFile) object, which can be either a file or a folder. Always check the concrete type of a `TAbstractFile` before you use it.

```ts
const folderOrFile = this.app.vault.getAbstractFileByPath("folderOrFile");

if (folderOrFile instanceof TFile) {
	console.log("It's a file!");
} else if (folderOrFile instanceof TFolder) {
	console.log("It's a folder!");
}
```
