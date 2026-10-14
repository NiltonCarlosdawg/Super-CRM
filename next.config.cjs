/** @type {import('next').next.Config} */
module.exports = {
  react17Compat: false,
  compiler: {
    removeEntityAttributes: false,
    removeInlineBreitespace: false,
  },
  images: {
    domains: ['fonts.googleapis.com'],
  },
}