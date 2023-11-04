import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextComponent,
	EditorPosition,
	setIcon,
	FileSystemAdapter,
} from "obsidian";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as crypto from "crypto";

interface pasteFunction {
	(this: HTMLElement, event: ClipboardEvent | DragEvent): void;
}

interface SpacesUploaderSettings {
	accessKey: string;
	secretKey: string;
	region: string;
	bucket: string;
	folder: string;
	imageUrlPath: string;
	uploadOnDrag: boolean;
	localUpload: boolean;
	localUploadFolder: string;
	endpoint: string;
	forcePathStyle: boolean;
	uploadVideo: boolean;
	uploadAudio: boolean;
	uploadPdf: boolean;
	public: boolean;
}

const DEFAULT_SETTINGS: SpacesUploaderSettings = {
	accessKey: "",
	secretKey: "",
	region: "",
	bucket: "",
	folder: "",
	imageUrlPath: "",
	uploadOnDrag: true,
	localUpload: false,
	localUploadFolder: "",
	endpoint: "",
	forcePathStyle: false,
	uploadVideo: false,
	uploadAudio: false,
	uploadPdf: false,
	public: true,
};

export default class SpacesUploaderPlugin extends Plugin {
	settings: SpacesUploaderSettings;
	s3: S3Client;
	pasteFunction: pasteFunction;

	private replaceText(
		editor: Editor,
		target: string,
		replacement: string
	): void {
		target = target.trim();
		const lines = editor.getValue().split("\n");
		for (let i = 0; i < lines.length; i++) {
			const ch = lines[i].indexOf(target);
			if (ch !== -1) {
				const from = { line: i, ch: ch } as EditorPosition;
				const to = {
					line: i,
					ch: ch + target.length,
				} as EditorPosition;
				editor.setCursor(from);
				editor.replaceRange(replacement, from, to);
				break;
			}
		}
	}

	async pasteHandler(
		ev: ClipboardEvent | DragEvent,
		editor: Editor
	): Promise<void> {
		if (ev.defaultPrevented) {
			return;
		}

		const noteFile = this.app.workspace.getActiveFile();

		if (!noteFile || !noteFile.name) return;

		// Handle frontmatter settings
		const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
		const fmUploadOnDrag = fm && fm.uploadOnDrag;
		const fmLocalUpload = fm && fm.localUpload;
		const fmUploadFolder = fm ? fm.localUploadFolder : null;
		const fmUploadVideo = fm && fm.uploadVideo;
		const fmUploadAudio = fm && fm.uploadAudio;
		const fmUploadPdf = fm && fm.uploadPdf;

		const localUpload = fmLocalUpload
			? fmLocalUpload
			: this.settings.localUpload;

		const uploadVideo = fmUploadVideo
			? fmUploadVideo
			: this.settings.uploadVideo;

		const uploadAudio = fmUploadAudio
			? fmUploadAudio
			: this.settings.uploadAudio;

		const uploadPdf = fmUploadPdf ? fmUploadPdf : this.settings.uploadPdf;

		let file = null;

		// figure out what kind of event we're handling
		switch (ev.type) {
			case "paste":
				file = (ev as ClipboardEvent).clipboardData?.files[0];
				break;
			case "drop":
				if (!this.settings.uploadOnDrag && !fmUploadOnDrag) {
					return;
				}
				file = (ev as DragEvent).dataTransfer?.files[0];
		}

		const imageType = /image.*/;
		const videoType = /video.*/;
		const audioType = /audio.*/;
		const pdfType = /application\/pdf/;

		let thisType = "";

		if (file?.type.match(videoType) && uploadVideo) {
			thisType = "video";
		} else if (file?.type.match(audioType) && uploadAudio) {
			thisType = "audio";
		} else if (file?.type.match(pdfType) && uploadPdf) {
			thisType = "pdf";
		} else if (file?.type.match(imageType)) {
			thisType = "image";
		}

		if (thisType && file) {
			ev.preventDefault();

			// set the placeholder text
			const buf = await file.arrayBuffer();
			const digest = crypto
				.createHash("md5")
				.update(new Uint8Array(buf))
				.digest("hex");
			const contentType = file?.type;
			const newFileName =
				digest +
				"." +
				file.name.slice(((file?.name.lastIndexOf(".") - 1) >>> 0) + 2);
			const pastePlaceText = `![uploading...](${newFileName})\n`;
			editor.replaceSelection(pastePlaceText);

			// upload the image
			const folder = fmUploadFolder
				? fmUploadFolder
				: this.settings.folder;
			const key = folder ? folder + "/" + newFileName : newFileName;

			if (!localUpload) {
				const client = new S3Client({
					region: this.settings.region,
					credentials: {
						accessKeyId: this.settings.accessKey,
						secretAccessKey: this.settings.secretKey,
					},
					endpoint: this.settings.endpoint,
					forcePathStyle: this.settings.forcePathStyle,
				});

				const command = new PutObjectCommand({
					Bucket: this.settings.bucket,
					Key: key,
					Body: new Uint8Array(await file.arrayBuffer()),
					ContentType: contentType ? contentType : undefined,
					ACL: this.settings.public ? "public-read" : "private",
				});

				const result = await client
					.send(command)
					.then((res) => {
						const url = this.settings.imageUrlPath + key;
						let imgMarkdownText = "";
						try {
							imgMarkdownText = wrapFileDependingOnType(
								url,
								thisType,
								""
							);
						} catch (error) {
							this.replaceText(editor, pastePlaceText, "");
							throw error;
						}

						this.replaceText(
							editor,
							pastePlaceText,
							imgMarkdownText
						);
						new Notice(
							`Image uploaded to S3 bucket: ${this.settings.bucket}`
						);
					})
					.catch((err) => {
						console.error(err);
						new Notice(
							`Error uploading image to S3 bucket ${this.settings.bucket}: ` +
								err.message
						);
					});
			} else {
				// Use local upload
				const localUploadFolder = fmUploadFolder
					? fmUploadFolder
					: this.settings.localUploadFolder;
				const localUploadPath = localUploadFolder
					? localUploadFolder + "/" + newFileName
					: newFileName;
				await this.app.vault.adapter.mkdir(localUploadFolder);
				this.app.vault.adapter
					.writeBinary(localUploadPath, buf)
					.then(() => {
						let basePath = "";
						const adapter = this.app.vault.adapter;
						if (adapter instanceof FileSystemAdapter) {
							basePath = adapter.getBasePath();
						}

						let imgMarkdownText = "";

						try {
							imgMarkdownText = wrapFileDependingOnType(
								localUploadPath,
								thisType,
								basePath
							);
						} catch (error) {
							this.replaceText(editor, pastePlaceText, "");
							throw error;
						}
						this.replaceText(
							editor,
							pastePlaceText,
							imgMarkdownText
						);
						new Notice(
							`Image uploaded to ${localUploadFolder} folder`
						);
					})
					.catch((err) => {
						console.log(err);
						new Notice(
							`Error uploading image to ${localUploadFolder} folder: ` +
								err.message
						);
					});
			}
		}
	}

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SpacesUploaderSettingTab(this.app, this));

		this.pasteFunction = this.pasteHandler.bind(this);

		this.registerEvent(
			this.app.workspace.on("editor-paste", this.pasteFunction)
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.pasteFunction)
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SpacesUploaderSettingTab extends PluginSettingTab {
	plugin: SpacesUploaderPlugin;

	constructor(app: App, plugin: SpacesUploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.containerEl.createEl("h1", {
			text: "Settings for Spaces/S3 Image Uploader",
		});
		new Setting(this.containerEl)
			.setName("S3 Access Key ID")
			.setDesc("S3 access key ID for a user with S3 access.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("access key")
					.setValue(this.plugin.settings.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.accessKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("S3 Secret Key")
			.setDesc("S3 secret key for that user.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("secret key")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("S3 Endpoint")
			.setDesc("Set your own S3 endpoint.")
			.addText((text) =>
				text
					.setPlaceholder("https://s3.myhost.com/")
					.setValue(this.plugin.settings.endpoint)
					.onChange(async (value) => {
						value = value.match(/https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^\/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.endpoint = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(this.containerEl)
			.setName("Region")
			.setDesc("AWS region of the S3 bucket.")
			.addText((text) =>
				text
					.setPlaceholder("aws region")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(this.containerEl)
			.setName("S3 Bucket")
			.setDesc("S3 bucket name.")
			.addText((text) =>
				text
					.setPlaceholder("bucket name")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(this.containerEl)
			.setName("Bucket folder")
			.setDesc("Optional folder in s3 bucket.")
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(this.containerEl)
			.setName("Public file")
			.setDesc(
				"Toggle to upload as public. If off the file wont be displayed"
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.public)
					.onChange(async (value) => {
						this.plugin.settings.public = value;
						await this.plugin.saveSettings();
					});
			});

		this.containerEl.createEl("h1", {
			text: "Advanced Settings",
		});

		new Setting(this.containerEl)
			.setName("Upload on drag")
			.setDesc(
				"Upload drag and drop images as well as pasted images. To override this setting on a per-document basis, you can add `uploadOnDrag: true` to YAML frontmatter of the note."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadOnDrag)
					.onChange(async (value) => {
						this.plugin.settings.uploadOnDrag = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("Upload video files")
			.setDesc(
				"Upload videos. To override this setting on a per-document basis, you can add `uploadVideo: true` to YAML frontmatter of the note."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadVideo)
					.onChange(async (value) => {
						this.plugin.settings.uploadVideo = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("Upload audio files")
			.setDesc(
				"Upload audio files. To override this setting on a per-document basis, you can add `uploadAudio: true` to YAML frontmatter of the note."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadAudio)
					.onChange(async (value) => {
						this.plugin.settings.uploadAudio = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("Upload pdf files")
			.setDesc(
				"Upload and embed PDF files. To override this setting on a per-document basis, you can add `uploadPdf: true` to YAML frontmatter of the note. Local uploads are not supported for PDF files."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadPdf)
					.onChange(async (value) => {
						this.plugin.settings.uploadPdf = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("Copy to local folder")
			.setDesc(
				"Copy images to local folder instead of s3. To override this setting on a per-document basis, you can add `uploadLocal: true` to YAML frontmatter of the note.  This will copy the images to a folder in your local file system, instead of s3."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.localUpload)
					.onChange(async (value) => {
						this.plugin.settings.localUpload = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(this.containerEl)
			.setName("Local folder")
			.setDesc(
				'Local folder to save images, instead of s3. To override this setting on a per-document basis, you can add `uploadFolder: "myFolder"` to YAML frontmatter of the note.  This affects only local uploads.'
			)
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.localUploadFolder)
					.onChange(async (value) => {
						this.plugin.settings.localUploadFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(this.containerEl)
			.setName("S3 Path Style URLs")
			.setDesc(
				"Advanced option to force using (legacy) path-style s3 URLs (s3.myhost.com/bucket) instead of the modern AWS standard host-style (bucket.s3.myhost.com)."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.forcePathStyle)
					.onChange(async (value) => {
						this.plugin.settings.forcePathStyle = value;
						await this.plugin.saveSettings();
					});
			});

		this.containerEl.createEl("hr");
		
		this.containerEl
			.createEl("b")
			.createEl("div", { text: "Credits:" })
			.createEl("small");

		const credits = this.containerEl.createEl("div").createEl("small");

		credits.createEl("span", { text: "Created by: " });

		credits.createEl("a", {
			text: "@Moonded",
			href: "https://github.com/Moonded",
		});

		credits.createEl("span", { text: " by help of " });

		credits.createEl("a", {
			text: "@jvsteiner",
			href: "https://github.com/jvsteiner",
		});
	}
}

const wrapTextWithPasswordHide = (text: TextComponent) => {
	const hider = text.inputEl.insertAdjacentElement(
		"beforebegin",
		createSpan()
	);
	if (!hider) {
		return;
	}
	setIcon(hider as HTMLElement, "eye-off");

	hider.addEventListener("click", () => {
		const isText = text.inputEl.getAttribute("type") === "text";
		if (isText) {
			setIcon(hider as HTMLElement, "eye-off");
			text.inputEl.setAttribute("type", "password");
		} else {
			setIcon(hider as HTMLElement, "eye");
			text.inputEl.setAttribute("type", "text");
		}
		text.inputEl.focus();
	});
	text.inputEl.setAttribute("type", "password");
	return text;
};

const wrapFileDependingOnType = (
	location: string,
	type: string,
	localBase: string
) => {
	const srcPrefix = localBase ? "file://" + localBase + "/" : "";

	if (type === "image") {
		return `![image](${location})`;
	} else if (type === "video") {
		return `<video src="${srcPrefix}${location}" controls />`;
	} else if (type === "audio") {
		return `<audio src="${srcPrefix}${location}" controls />`;
	} else if (type === "pdf") {
		if (localBase) {
			throw new Error("PDFs cannot be embedded in local mode");
		}
		return `<iframe frameborder=0 border=0 width=100% height=800
	src="https://docs.google.com/viewer?url=${location}?raw=true">
</iframe>`;
	} else {
		throw new Error("Unknown file type");
	}
};
