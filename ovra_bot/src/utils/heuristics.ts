// src/utils/heuristics.ts

const triggerWords = [
    "сделать", "нужно", "задача", "deadline", "надо", 
    "успеть", "к завтрашнему", "до пятницы", "баг", "поправить"
];

export function isPotentialTask(text: string): boolean {
    if (!text || text.length < 15) return false; // Слишком коротко
    if (text.includes("?")) return false; // Вопросы пропускаем
    
    const lowerText = text.toLowerCase();
    
    // Ищем хотя бы одно слово-триггер
    return triggerWords.some(word => lowerText.includes(word));
}