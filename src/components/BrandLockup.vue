<script setup lang="ts">
withDefaults(
	defineProps<{
		compact?: boolean;
	}>(),
	{
		compact: false,
	},
);
</script>

<template>
	<div class="brand-lockup" :class="{ compact }" aria-label="本地试验台">
		<img
			class="brand-mark"
			src="@/assets/icon/local-test-lab-mark.svg"
			alt="本地试验台图标"
			draggable="false"
		/>
		<div class="brand-copy">
			<div class="brand-name">本地试验台</div>
			<div class="brand-caption">LOCAL TEST LAB</div>
		</div>
	</div>
</template>

<style scoped>
.brand-lockup {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	min-width: max-content;
	user-select: none;
}

.brand-mark {
	width: 38px;
	height: 38px;
	flex: 0 0 auto;
}

.brand-copy {
	display: flex;
	flex-direction: column;
	gap: 1px;
	line-height: 1;
}

.brand-name {
	color: #30343b;
	font-size: 15px;
	font-weight: 700;
	letter-spacing: 0.04em;
}

.brand-caption {
	color: #7b8491;
	font-size: 8px;
	font-weight: 700;
	letter-spacing: 0.16em;
}

.brand-lockup.compact .brand-mark {
	width: 34px;
	height: 34px;
}

.brand-lockup.compact .brand-name {
	font-size: 14px;
}

.dark .brand-name {
	color: #edf4ff;
}

.dark .brand-caption {
	color: #a5b4c8;
}
</style>
