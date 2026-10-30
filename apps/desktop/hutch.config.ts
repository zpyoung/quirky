export default {
  scripts: {
    start: ['hutch', 'electrobun', 'dev'],
    build: ['hutch', 'electrobun', 'build', '--env=stable']
  },
  electrobun: {
    version: '2.0.5-quirky.1'
  }
}
