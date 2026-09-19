/*
 * Service worker τερματισμού.
 *
 * Αντικαθιστά τον service worker της παλιάς εφαρμογής ταμείου. Δεν αποθηκεύει
 * τίποτα και δεν εξυπηρετεί τίποτα: μόλις ενεργοποιηθεί, αδειάζει κάθε
 * αποθηκευμένη μνήμη, ξεγράφει τον εαυτό του και ξαναφορτώνει τις ανοιχτές
 * καρτέλες ώστε να δουν τη σελίδα τερματισμού αντί για το παλιό αντίγραφο.
 *
 * Υπάρχει ως δεύτερη γραμμή άμυνας: ο browser κατεβάζει μόνος του νέο sw.js
 * όταν ανοίξει η εφαρμογή, οπότε συσκευές που δεν προλάβουν να τρέξουν τον
 * διακόπτη του index.html καθαρίζονται από εδώ.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));

    await self.registration.unregister();

    const windows = await self.clients.matchAll({ type: 'window' });
    for (const client of windows) {
      client.navigate(client.url);
    }
  })());
});
