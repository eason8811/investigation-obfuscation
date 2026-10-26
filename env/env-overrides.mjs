export function inspectBrowserEnvironment(Window) {
    const checks = {
        Window: [
            "performance",
            "crypto",
            "HTMLMediaElement",
            "HTMLVideoElement",
            "Intl",
            "Promise"
        ],

        Document: [
            "currentScript",
            "readyState",
            "createElement",
            "body",
            "addEventListener"
        ],

        Navigator: [
            "plugins",
            "mimeTypes",
            "userAgent",
            "userAgentData",
            "bluetooth"
        ]
    };

    const objects = {
        Window,
        Document: Window.document,
        Navigator: Window.navigator
    };

    for (const [label, properties] of Object.entries(checks)) {
        const obj = objects[label];

        console.log(`\n[${label}]`);

        for (const property of properties) {
            try {
                console.log({
                    property,
                    exists: property in obj,
                    type: typeof obj[property]
                });
            } catch (error) {
                console.log({
                    property,
                    error: error.message
                });
            }
        }
    }
}