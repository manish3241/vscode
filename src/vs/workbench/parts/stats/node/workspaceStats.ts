/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { localize } from 'vs/nls';
import * as crypto from 'crypto';
import { TPromise } from 'vs/base/common/winjs.base';
import { onUnexpectedError } from 'vs/base/common/errors';
import { URI } from 'vs/base/common/uri';
import { IFileService, IFileStat, IResolveFileResult } from 'vs/platform/files/common/files';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IWindowConfiguration, IWindowService } from 'vs/platform/windows/common/windows';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { endsWith } from 'vs/base/common/strings';
import { Schemas } from 'vs/base/common/network';
import { INotificationService, Severity, IPromptChoice } from 'vs/platform/notification/common/notification';
import { extname, join } from 'path';
import { WORKSPACE_EXTENSION } from 'vs/platform/workspaces/common/workspaces';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';

const SshProtocolMatcher = /^([^@:]+@)?([^:]+):/;
const SshUrlMatcher = /^([^@:]+@)?([^:]+):(.+)$/;
const AuthorityMatcher = /^([^@]+@)?([^:]+)(:\d+)?$/;
const SecondLevelDomainMatcher = /([^@:.]+\.[^@:.]+)(:\d+)?$/;
const RemoteMatcher = /^\s*url\s*=\s*(.+\S)\s*$/mg;
const AnyButDot = /[^.]/g;
const SecondLevelDomainWhitelist = [
	'github.com',
	'bitbucket.org',
	'visualstudio.com',
	'gitlab.com',
	'heroku.com',
	'azurewebsites.net',
	'ibm.com',
	'amazon.com',
	'amazonaws.com',
	'cloudapp.net',
	'rhcloud.com',
	'google.com'
];
const ModulesToLookFor = [
	// Packages that suggest a node server
	'express',
	'sails',
	'koa',
	'hapi',
	'socket.io',
	'restify',
	// JS frameworks
	'react',
	'react-native',
	'@angular/core',
	'vue',
	// Other interesting packages
	'aws-sdk',
	'azure',
	'azure-storage',
	'@google-cloud/common',
	'heroku-cli'
];

type Tags = { [index: string]: boolean | number | string };

function stripLowLevelDomains(domain: string): string {
	const match = domain.match(SecondLevelDomainMatcher);
	return match ? match[1] : null;
}

function extractDomain(url: string): string {
	if (url.indexOf('://') === -1) {
		const match = url.match(SshProtocolMatcher);
		if (match) {
			return stripLowLevelDomains(match[2]);
		} else {
			return null;
		}
	}
	try {
		const uri = URI.parse(url);
		if (uri.authority) {
			return stripLowLevelDomains(uri.authority);
		}
	} catch (e) {
		// ignore invalid URIs
	}
	return null;
}

export function getDomainsOfRemotes(text: string, whitelist: string[]): string[] {
	const domains = new Set<string>();
	let match: RegExpExecArray;
	while (match = RemoteMatcher.exec(text)) {
		const domain = extractDomain(match[1]);
		if (domain) {
			domains.add(domain);
		}
	}

	const whitemap = whitelist.reduce((map, key) => {
		map[key] = true;
		return map;
	}, Object.create(null));

	const elements: string[] = [];
	domains.forEach(e => elements.push(e));

	return elements
		.map(key => whitemap[key] ? key : key.replace(AnyButDot, 'a'));
}

function stripPort(authority: string): string {
	const match = authority.match(AuthorityMatcher);
	return match ? match[2] : null;
}

function normalizeRemote(host: string, path: string, stripEndingDotGit: boolean): string {
	if (host && path) {
		if (stripEndingDotGit && endsWith(path, '.git')) {
			path = path.substr(0, path.length - 4);
		}
		return (path.indexOf('/') === 0) ? `${host}${path}` : `${host}/${path}`;
	}
	return null;
}

function extractRemote(url: string, stripEndingDotGit: boolean): string {
	if (url.indexOf('://') === -1) {
		const match = url.match(SshUrlMatcher);
		if (match) {
			return normalizeRemote(match[2], match[3], stripEndingDotGit);
		}
	}
	try {
		const uri = URI.parse(url);
		if (uri.authority) {
			return normalizeRemote(stripPort(uri.authority), uri.path, stripEndingDotGit);
		}
	} catch (e) {
		// ignore invalid URIs
	}
	return null;
}

export function getRemotes(text: string, stripEndingDotGit: boolean = false): string[] {
	const remotes: string[] = [];
	let match: RegExpExecArray;
	while (match = RemoteMatcher.exec(text)) {
		const remote = extractRemote(match[1], stripEndingDotGit);
		if (remote) {
			remotes.push(remote);
		}
	}
	return remotes;
}

export function getHashedRemotesFromConfig(text: string, stripEndingDotGit: boolean = false): string[] {
	return getRemotes(text, stripEndingDotGit).map(r => {
		return crypto.createHash('sha1').update(r).digest('hex');
	});
}

export function getHashedRemotesFromUri(workspaceUri: URI, fileService: IFileService, stripEndingDotGit: boolean = false): TPromise<string[]> {
	const path = workspaceUri.path;
	const uri = workspaceUri.with({ path: `${path !== '/' ? path : ''}/.git/config` });
	return fileService.resolveFile(uri).then(() => {
		return fileService.resolveContent(uri, { acceptTextOnly: true }).then(
			content => getHashedRemotesFromConfig(content.value, stripEndingDotGit),
			err => [] // ignore missing or binary file
		);
	}, err => []);
}

export class WorkspaceStats implements IWorkbenchContribution {

	private static DISABLE_WORKSPACE_PROMPT_KEY = 'workspaces.dontPromptToOpen';

	constructor(
		@IFileService private fileService: IFileService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IWindowService private windowService: IWindowService,
		@INotificationService private notificationService: INotificationService,
		@IQuickInputService private quickInputService: IQuickInputService,
		@IStorageService private storageService: IStorageService
	) {
		this.reportWorkspaceTags(windowService.getConfiguration());
		this.reportCloudStats();
	}

	static TAGS: Tags;

	private searchArray(arr: string[], regEx: RegExp): boolean {
		return arr.some(v => v.search(regEx) > -1) || undefined;
	}

	/* __GDPR__FRAGMENT__
		"WorkspaceTags" : {
			"workbench.filesToOpen" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workbench.filesToCreate" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workbench.filesToDiff" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.id" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			"workspace.roots" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.empty" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.grunt" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.gulp" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.jake" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.tsconfig" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.jsconfig" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.config.xml" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.vsc.extension" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.asp<NUMBER>" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.sln" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.unity" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.express" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.sails" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.koa" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.hapi" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.socket.io" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.restify" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.react" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.@angular/core" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.vue" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.aws-sdk" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.azure" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.azure-storage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.@google-cloud/common" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.npm.heroku-cli" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.bower" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.yeoman.code.ext" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.cordova.high" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.cordova.low" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.xamarin.android" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.xamarin.ios" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.android.cpp" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
			"workspace.reactNative" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
		}
	*/
	private getWorkspaceTags(configuration: IWindowConfiguration): TPromise<Tags> {
		const tags: Tags = Object.create(null);

		const state = this.contextService.getWorkbenchState();
		const workspace = this.contextService.getWorkspace();

		let workspaceId: string;
		let isSingleLocalWorkspaceFolder = false;
		switch (state) {
			case WorkbenchState.EMPTY:
				workspaceId = void 0;
				break;
			case WorkbenchState.FOLDER:
				isSingleLocalWorkspaceFolder = workspace.folders[0].uri.scheme === Schemas.file;
				workspaceId = crypto.createHash('sha1').update(isSingleLocalWorkspaceFolder ? workspace.folders[0].uri.fsPath : workspace.folders[0].uri.toString()).digest('hex'); // TODO: #54483 @Ben
				break;
			case WorkbenchState.WORKSPACE:
				workspaceId = crypto.createHash('sha1').update(workspace.configuration.fsPath).digest('hex');
		}

		tags['workspace.id'] = workspaceId;

		const { filesToOpen, filesToCreate, filesToDiff } = configuration;
		tags['workbench.filesToOpen'] = filesToOpen && filesToOpen.length || 0;
		tags['workbench.filesToCreate'] = filesToCreate && filesToCreate.length || 0;
		tags['workbench.filesToDiff'] = filesToDiff && filesToDiff.length || 0;

		const isEmpty = state === WorkbenchState.EMPTY;
		tags['workspace.roots'] = isEmpty ? 0 : workspace.folders.length;
		tags['workspace.empty'] = isEmpty;

		const folders = !isEmpty ? workspace.folders.map(folder => folder.uri) : this.environmentService.appQuality !== 'stable' && this.findFolders(configuration);
		if (!folders || !folders.length || !this.fileService) {
			return TPromise.as(tags);
		}

		return this.fileService.resolveFiles(folders.map(resource => ({ resource }))).then((files: IResolveFileResult[]) => {
			const names = (<IFileStat[]>[]).concat(...files.map(result => result.success ? (result.stat.children || []) : [])).map(c => c.name);
			const nameSet = names.reduce((s, n) => s.add(n.toLowerCase()), new Set());

			tags['workspace.grunt'] = nameSet.has('gruntfile.js');
			tags['workspace.gulp'] = nameSet.has('gulpfile.js');
			tags['workspace.jake'] = nameSet.has('jakefile.js');

			tags['workspace.tsconfig'] = nameSet.has('tsconfig.json');
			tags['workspace.jsconfig'] = nameSet.has('jsconfig.json');
			tags['workspace.config.xml'] = nameSet.has('config.xml');
			tags['workspace.vsc.extension'] = nameSet.has('vsc-extension-quickstart.md');

			tags['workspace.ASP5'] = nameSet.has('project.json') && this.searchArray(names, /^.+\.cs$/i);
			tags['workspace.sln'] = this.searchArray(names, /^.+\.sln$|^.+\.csproj$/i);
			tags['workspace.unity'] = nameSet.has('assets') && nameSet.has('library') && nameSet.has('projectsettings');
			tags['workspace.npm'] = nameSet.has('package.json') || nameSet.has('node_modules');
			tags['workspace.bower'] = nameSet.has('bower.json') || nameSet.has('bower_components');

			tags['workspace.yeoman.code.ext'] = nameSet.has('vsc-extension-quickstart.md');

			const mainActivity = nameSet.has('mainactivity.cs') || nameSet.has('mainactivity.fs');
			const appDelegate = nameSet.has('appdelegate.cs') || nameSet.has('appdelegate.fs');
			const androidManifest = nameSet.has('androidmanifest.xml');

			const platforms = nameSet.has('platforms');
			const plugins = nameSet.has('plugins');
			const www = nameSet.has('www');
			const properties = nameSet.has('properties');
			const resources = nameSet.has('resources');
			const jni = nameSet.has('jni');

			if (tags['workspace.config.xml'] &&
				!tags['workspace.language.cs'] && !tags['workspace.language.vb'] && !tags['workspace.language.aspx']) {
				if (platforms && plugins && www) {
					tags['workspace.cordova.high'] = true;
				} else {
					tags['workspace.cordova.low'] = true;
				}
			}

			if (mainActivity && properties && resources) {
				tags['workspace.xamarin.android'] = true;
			}

			if (appDelegate && resources) {
				tags['workspace.xamarin.ios'] = true;
			}

			if (androidManifest && jni) {
				tags['workspace.android.cpp'] = true;
			}

			const packageJsonPromises = !nameSet.has('package.json') ? [] : folders.map(workspaceUri => {
				const uri = workspaceUri.with({ path: `${workspaceUri.path !== '/' ? workspaceUri.path : ''}/package.json` });
				return this.fileService.resolveFile(uri).then(() => {
					return this.fileService.resolveContent(uri, { acceptTextOnly: true }).then(content => {
						try {
							const packageJsonContents = JSON.parse(content.value);
							if (packageJsonContents['dependencies']) {
								for (let module of ModulesToLookFor) {
									if ('react-native' === module) {
										if (packageJsonContents['dependencies'][module]) {
											tags['workspace.reactNative'] = true;
										}
									} else {
										if (packageJsonContents['dependencies'][module]) {
											tags['workspace.npm.' + module] = true;
										}
									}
								}
							}
						}
						catch (e) {
							// Ignore errors when resolving file or parsing file contents
						}
					});
				}, err => {
					// Ignore missing file
				});
			});

			// Handle top-level workspace files for local single folder workspace
			if (isSingleLocalWorkspaceFolder) {
				const workspaceFiles = names.filter(name => extname(name) === `.${WORKSPACE_EXTENSION}`);
				if (workspaceFiles.length > 0) {
					this.handleWorkspaceFiles(workspace.folders[0].uri, workspaceFiles);
				}
			}

			return TPromise.join(packageJsonPromises).then(() => tags);
		});
	}

	private handleWorkspaceFiles(folder: URI, workspaces: string[]): void {
		if (this.storageService.getBoolean(WorkspaceStats.DISABLE_WORKSPACE_PROMPT_KEY, StorageScope.WORKSPACE)) {
			return; // prompt disabled by user
		}

		const doNotShowAgain: IPromptChoice = {
			label: localize('never again', "Don't Show Again"),
			isSecondary: true,
			run: () => this.storageService.store(WorkspaceStats.DISABLE_WORKSPACE_PROMPT_KEY, true, StorageScope.WORKSPACE)
		};

		// Prompt to open one workspace
		if (workspaces.length === 1) {
			const workspaceFile = workspaces[0];

			this.notificationService.prompt(Severity.Info, localize('workspaceFound', "This folder contains a workspace file '{0}'. Do you want to open it (click [here]({1}) to learn more)?", workspaceFile, 'https://code.visualstudio.com/docs/editor/multi-root-workspaces'), [{
				label: localize('openWorkspace', "Open Workspace"),
				run: () => this.windowService.openWindow([URI.file(join(folder.fsPath, workspaceFile))])
			}, doNotShowAgain]);
		}

		// Prompt to select a workspace from many
		else if (workspaces.length > 1) {
			this.notificationService.prompt(Severity.Info, localize('workspacesFound', "This folder contains multiple workspace files. Do you want to open one (click [here]({0}) to learn more)?", 'https://code.visualstudio.com/docs/editor/multi-root-workspaces'), [{
				label: localize('selectWorkspace', "Select Workspace"),
				run: () => {
					this.quickInputService.pick(
						workspaces.map(workspace => ({ label: workspace } as IQuickPickItem)),
						{ placeHolder: localize('selectToOpen', "Select a workspace to open") }).then(pick => {
							if (pick) {
								this.windowService.openWindow([URI.file(join(folder.fsPath, pick.label))]);
							}
						});
				}
			}, doNotShowAgain]);
		}
	}

	private findFolders(configuration: IWindowConfiguration): URI[] {
		const folder = this.findFolder(configuration);
		return folder && [folder];
	}

	private findFolder({ filesToOpen, filesToCreate, filesToDiff }: IWindowConfiguration): URI {
		if (filesToOpen && filesToOpen.length) {
			return this.parentURI(filesToOpen[0].fileUri);
		} else if (filesToCreate && filesToCreate.length) {
			return this.parentURI(filesToCreate[0].fileUri);
		} else if (filesToDiff && filesToDiff.length) {
			return this.parentURI(filesToDiff[0].fileUri);
		}
		return undefined;
	}

	private parentURI(uri: URI): URI {
		const path = uri.path;
		const i = path.lastIndexOf('/');
		return i !== -1 ? uri.with({ path: path.substr(0, i) }) : undefined;
	}

	reportWorkspaceTags(configuration: IWindowConfiguration): void {
		this.getWorkspaceTags(configuration).then((tags) => {
			/* __GDPR__
				"workspce.tags" : {
					"${include}": [
						"${WorkspaceTags}"
					]
				}
			*/
			this.telemetryService.publicLog('workspce.tags', tags);
			WorkspaceStats.TAGS = tags;
		}, error => onUnexpectedError(error));
	}

	private reportRemoteDomains(workspaceUris: URI[]): void {
		TPromise.join<string[]>(workspaceUris.map(workspaceUri => {
			const path = workspaceUri.path;
			const uri = workspaceUri.with({ path: `${path !== '/' ? path : ''}/.git/config` });
			return this.fileService.resolveFile(uri).then(() => {
				return this.fileService.resolveContent(uri, { acceptTextOnly: true }).then(
					content => getDomainsOfRemotes(content.value, SecondLevelDomainWhitelist),
					err => [] // ignore missing or binary file
				);
			}, err => []);
		})).then(domains => {
			const set = domains.reduce((set, list) => list.reduce((set, item) => set.add(item), set), new Set<string>());
			const list: string[] = [];
			set.forEach(item => list.push(item));
			/* __GDPR__
				"workspace.remotes" : {
					"domains" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetryService.publicLog('workspace.remotes', { domains: list.sort() });
		}, onUnexpectedError);
	}

	private reportRemotes(workspaceUris: URI[]): void {
		TPromise.join<string[]>(workspaceUris.map(workspaceUri => {
			return getHashedRemotesFromUri(workspaceUri, this.fileService, true);
		})).then(hashedRemotes => {
			/* __GDPR__
					"workspace.hashedRemotes" : {
						"remotes" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
					}
				*/
			this.telemetryService.publicLog('workspace.hashedRemotes', { remotes: hashedRemotes });
		}, onUnexpectedError);
	}

	/* __GDPR__FRAGMENT__
		"AzureTags" : {
			"node" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
		}
	*/
	private reportAzureNode(workspaceUris: URI[], tags: Tags): TPromise<Tags> {
		// TODO: should also work for `node_modules` folders several levels down
		const uris = workspaceUris.map(workspaceUri => {
			const path = workspaceUri.path;
			return workspaceUri.with({ path: `${path !== '/' ? path : ''}/node_modules` });
		});
		return this.fileService.resolveFiles(uris.map(resource => ({ resource }))).then(
			results => {
				const names = (<IFileStat[]>[]).concat(...results.map(result => result.success ? (result.stat.children || []) : [])).map(c => c.name);
				const referencesAzure = this.searchArray(names, /azure/i);
				if (referencesAzure) {
					tags['node'] = true;
				}
				return tags;
			},
			err => {
				return tags;
			});
	}

	/* __GDPR__FRAGMENT__
		"AzureTags" : {
			"java" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
		}
	*/
	private reportAzureJava(workspaceUris: URI[], tags: Tags): TPromise<Tags> {
		return TPromise.join(workspaceUris.map(workspaceUri => {
			const path = workspaceUri.path;
			const uri = workspaceUri.with({ path: `${path !== '/' ? path : ''}/pom.xml` });
			return this.fileService.resolveFile(uri).then(stats => {
				return this.fileService.resolveContent(uri, { acceptTextOnly: true }).then(
					content => !!content.value.match(/azure/i),
					err => false
				);
			}, err => false);
		})).then(javas => {
			if (javas.indexOf(true) !== -1) {
				tags['java'] = true;
			}
			return tags;
		});
	}

	private reportAzure(uris: URI[]) {
		const tags: Tags = Object.create(null);
		this.reportAzureNode(uris, tags).then((tags) => {
			return this.reportAzureJava(uris, tags);
		}).then((tags) => {
			if (Object.keys(tags).length) {
				/* __GDPR__
					"workspace.azure" : {
						"${include}": [
							"${AzureTags}"
						]
					}
				*/
				this.telemetryService.publicLog('workspace.azure', tags);
			}
		}).then(null, onUnexpectedError);
	}

	reportCloudStats(): void {
		const uris = this.contextService.getWorkspace().folders.map(folder => folder.uri);
		if (uris.length && this.fileService) {
			this.reportRemoteDomains(uris);
			this.reportRemotes(uris);
			this.reportAzure(uris);
		}
	}
}