// Import package.json for version synchronization
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';


let pkgVersion = '';

export const getPackageVersion = () => {

  if(!pkgVersion) {
    // Get the directory path of the current module
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Read package.json to get the version
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, './package.json'), 'utf8')
    );

    pkgVersion = packageJson.version;
  }

  return pkgVersion;

};

