[Module description]

## Installation

### Install

In your terminal, go to your [MagicMirror²][mm] Module folder and clone MMM-Gemini:

```bash
cd ~/MagicMirror/modules
git clone [GitHub url]
```

### Update

```bash
cd ~/MagicMirror/modules/MMM-Gemini
git pull
```

## Using the module

To use this module, add it to the modules array in the `config/config.js` file:

```js
    {
            module: 'MMM-Gemini',
            position: 'lower_third',
            config: {
                    apiKey: 'YOUR_GEMINI_KEY_HERE',
            }
    },
```
## Developer commands

- `npm install` - Install devDependencies like ESLint.
- `npm run lint` - Run linting and formatter checks.
- `npm run lint:fix` - Fix linting and formatter issues.

[mm]: https://github.com/MagicMirrorOrg/MagicMirror

## Restarting mirror to see logs for debugging/developing

pm2 restart mm --no-daemon