module.exports = [
    {
        name: 'music',
        description: "OsQarek's Universe Audio Suite",
        options: [
            { name: 'play', description: 'Play music from SoundCloud', type: 1, options: [{ name: 'query', description: 'The song name or URL', type: 3, required: true }] },
            { name: 'skip', description: 'Skip the current song', type: 1 },
            { name: 'queue', description: 'View the music queue', type: 1 },
            { name: 'pause', description: 'Pause the current song', type: 1 },
            { name: 'resume', description: 'Resume the paused song', type: 1 },
            { name: 'leave', description: 'Stop music and leave the voice channel', type: 1 },
            { name: 'join', description: 'Join the voice channel', type: 1 },
            { name: 'volume', description: 'Set volume (0-100)', type: 1, options: [{ name: 'level', description: 'The volume level', type: 10, required: true }] },
            { name: 'autoplay', description: 'Toggle autoplay mode', type: 1 },
            { name: '247', description: 'Toggle 24/7 mode (stay in VC)', type: 1 },
            { name: 'clear', description: 'Clear the music queue', type: 1 },
            { name: 'nowplaying', description: 'Now playing', type: 1 },
        ],
    },
];
