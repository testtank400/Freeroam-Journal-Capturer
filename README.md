# Freeroam Journal Capturer

A simple, double-clickable Windows tool that captures your **Freeroam** journal entries using real Chrome (with persistent login).

## Features

- Paste any `/story` URL → captures the full journal via the official API
- Saves a clean folder with `journal-raw.json` and nicely formatted `journal.md`
- "Reset Login" button to clear cookies when needed

## How to Use

1. Download the latest `.exe` from the (https://drive.google.com/open?id=1eFmuiBHcfHS4POF07p_nKbx7Ad9oGztX&usp=drive_fs) page
2. Run the installer (or the portable `.exe`)
3. Paste a Freeroam story URL and click **Capture Journal**
4. On first use, Chrome will open visibly — log in, then click OK
5. By default, captured files are saved to:  
   `Documents\Freeroam Captures\StoryTitle - timestamp\`

## Development

```bash
# Clone the repo
git clone https://github.com/yourusername/freeroam-journal-capturer.git
cd freeroam-journal-capturer

# Install dependencies
npm install

# Install Playwright browsers (only needed once)
npx playwright install chromium

# Run in development mode
npm start

# Build the installer
npm run dist
