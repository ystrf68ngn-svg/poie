module.exports = {
  appId: 'com.tongpin.desktop', productName: 'poie',
  directories: { app: '.desktop/app', output: 'releases/desktop', buildResources: 'desktop/assets' },
  files: ['main.mjs', '*.LEGAL.txt', 'preload.cjs', 'package.json', 'ui/**/*', '!node_modules{,/**/*}'],
  extraResources: [{ from: '.desktop/runtime', to: 'runtime', filter: ['**/*'] }],
  asar: true, npmRebuild: false, nodeGypRebuild: false,
  artifactName: 'poie-${version}-${os}-${arch}.${ext}',
  mac: { target: ['dmg'], category: 'public.app-category.productivity', icon: 'desktop/assets/icon.icns', identity: process.env.CSC_LINK || process.env.CSC_NAME ? undefined : '-', hardenedRuntime: true, gatekeeperAssess: false, minimumSystemVersion: '13.0.0' },
  dmg: { title: 'poie ${version}', window: { width: 540, height: 360 }, contents: [{ x: 150, y: 180, type: 'file' }, { x: 390, y: 180, type: 'link', path: '/Applications' }] },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop/assets/icon.ico', signExecutable: process.env.CSC_LINK || process.env.WIN_CSC_LINK ? undefined : false },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'poie', deleteAppDataOnUninstall: false, installerLanguages: ['zh_CN', 'en_US'], language: '2052', runAfterFinish: true },
};
