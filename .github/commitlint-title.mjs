export default {
	extends: ['@commitlint/config-conventional'],
	defaultIgnores: false,
	// GitHub's Revert button titles a PR `Revert "<title>"`, which commit-analyzer releases as a patch
	ignores: [(message) => message.startsWith('Revert "')],
	rules: {
		'subject-case': [0],
	},
};
