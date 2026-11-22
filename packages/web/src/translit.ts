/** Common first names and surnames, spelled the way Hindi speakers write them. */
const NAMES: Record<string, string> = {
  arjun: 'अर्जुन', aman: 'अमन', amit: 'अमित', anil: 'अनिल', anita: 'अनीता', anjali: 'अंजलि', ankit: 'अंकित', ankita: 'अंकिता', arun: 'अरुण', aryan: 'आर्यन', ashok: 'अशोक', asha: 'आशा', deepak: 'दीपक', deepika: 'दीपिका', dinesh: 'दिनेश',
  gaurav: 'गौरव', geeta: 'गीता', harsh: 'हर्ष', himanshu: 'हिमांशु', isha: 'ईशा', jyoti: 'ज्योति', kajal: 'काजल', kavita: 'कविता', kiran: 'किरण', kirti: 'कीर्ति', krishna: 'कृष्ण', kunal: 'कुणाल', lakshmi: 'लक्ष्मी', manish: 'मनीष', manoj: 'मनोज',
  meena: 'मीना', mohit: 'मोहित', mohan: 'मोहन', mukesh: 'मुकेश', naveen: 'नवीन', neha: 'नेहा', nikhil: 'निखिल', nisha: 'निशा', parth: 'पार्थ', pooja: 'पूजा', prakash: 'प्रकाश', pradeep: 'प्रदीप', priya: 'प्रिया', priyanka: 'प्रियंका', rahul: 'राहुल',
  rajesh: 'राजेश', rakesh: 'राकेश', ramesh: 'रमेश', ravi: 'रवि', rekha: 'रेखा', rohit: 'रोहित', ritu: 'ऋतु', sachin: 'सचिन', sandeep: 'संदीप', sanjay: 'संजय', sapna: 'सपना', seema: 'सीमा', shivam: 'शिवम', shweta: 'श्वेता', sita: 'सीता', sonu: 'सोनू',
  sunil: 'सुनील', suresh: 'सुरेश', sumit: 'सुमित', tarun: 'तरुण', vijay: 'विजय', vikas: 'विकास', vikram: 'विक्रम', vinod: 'विनोद', vishal: 'विशाल', yash: 'यश', yogesh: 'योगेश',
  sharma: 'शर्मा', verma: 'वर्मा', singh: 'सिंह', kumar: 'कुमार', gupta: 'गुप्ता', yadav: 'यादव', bhardwaj: 'भारद्वाज', mishra: 'मिश्रा', tiwari: 'तिवारी', pandey: 'पांडेय', chaudhary: 'चौधरी', jain: 'जैन', agarwal: 'अग्रवाल', saini: 'सैनी', thakur: 'ठाकुर',
};

const VOWELS: [string, string, string][] = [['aa', 'आ', 'ा'], ['ee', 'ई', 'ी'], ['ii', 'ई', 'ी'], ['oo', 'ऊ', 'ू'], ['uu', 'ऊ', 'ू'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'], ['ou', 'औ', 'ौ'], ['a', 'अ', ''], ['i', 'इ', 'ि'], ['u', 'उ', 'ु'], ['e', 'ए', 'े'], ['o', 'ओ', 'ो']];
const CONSONANTS: [string, string][] = [['chh', 'छ'], ['shh', 'ष'], ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'], ['th', 'थ'], ['dh', 'ध'], ['ph', 'फ'], ['bh', 'भ'], ['sh', 'श'], ['ng', 'ंग'], ['k', 'क'], ['g', 'ग'], ['c', 'क'], ['j', 'ज'], ['t', 'त'], ['d', 'द'], ['n', 'न'], ['p', 'प'], ['b', 'ब'], ['m', 'म'], ['y', 'य'], ['r', 'र'], ['l', 'ल'], ['v', 'व'], ['w', 'व'], ['s', 'स'], ['h', 'ह'], ['f', 'फ'], ['z', 'ज'], ['q', 'क'], ['x', 'क्स']];

/** A best-effort spelling for names that are not in the list. People can edit the result, so it only has to be close. */
function rules(word: string): string {
  let out = '';
  let i = 0;
  let needsVowel = false; // the last thing written was a bare consonant
  while (i < word.length) {
    const rest = word.slice(i);
    const v = VOWELS.find(([k]) => rest.startsWith(k));
    if (v) {
      if (needsVowel) out += v[2]; else out += v[1];
      needsVowel = false; i += v[0].length; continue;
    }
    const c = CONSONANTS.find(([k]) => rest.startsWith(k));
    if (!c) { i++; continue; }
    if (needsVowel) out += '्'; // two consonants in a row join
    out += c[1]; needsVowel = true; i += c[0].length;
  }
  return out; // a final consonant keeps its short "a", which Hindi does not write
}

export function toHindiName(name: string): string {
  return name.trim().split(/\s+/).map((w) => NAMES[w.toLowerCase()] ?? (/^[a-z]+$/i.test(w) ? rules(w.toLowerCase()) : w)).join(' ');
}
export const isDevanagari = (s: string): boolean => /[\u0900-\u097F]/.test(s);
