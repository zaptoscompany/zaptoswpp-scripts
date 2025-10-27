(function() {

function trocarTexto() {

// Seletor 1 - Tab principal

const smsTab = document.querySelector('#composer-textarea > div > div.flex.flex-col.flex-1.min-w-0.h-full.rounded-md.border-none > div.flex.flex-row.py-1.items-center.justify-end.rounded-t-lg.\\!h-\\[32px\\].bg-gray-50 > div.flex.gap-6.items-center.w-full > div > span');

if (smsTab && smsTab.innerText.trim() === 'SMS') {

smsTab.innerText = 'WhatsApp QR';

}

// Seletor 2 - Popover

const smsPopover = document.querySelector('#provider-select-popover > div.hr-popover__content > div > div > div.flex.items-center.justify-between.py-2.px-2.cursor-pointer.transition-colors.duration-150.hover\\:bg-gray-50.bg-blue-50 > div > div');

if (smsPopover && smsPopover.innerText.trim() === 'SMS') {

smsPopover.innerText = 'WhatsApp QR';

}

}

// Primeiro tenta de imediato

trocarTexto();

// Observa mudanças no DOM

const observer = new MutationObserver(() => {

trocarTexto();

});

observer.observe(document.body, {

childList: true,

subtree: true

});

})();
